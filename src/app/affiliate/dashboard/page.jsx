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
  Home, Plus, MoreHorizontal, X, Rocket, Gift,
} from "lucide-react";
import UgcTab from "./UgcTab";
import DepositTab from "./DepositTab";
import BoosterTab from "./BoosterTab";
import RewardsTab from "./RewardsTab";
import LiveActivity from "@/components/LiveActivity";
import { diffNewItems, shouldPlaySaleSound } from "@/lib/liveFeed";
import { createSaleSound } from "./saleSound";
import { resolveSupportLink } from "@/lib/whatsappSupport";
import { useLanguage } from "@/context/LanguageContext";
import { orderStatusErrorMessage, shouldRefreshOrdersAfter, orderMessageDir } from "@/lib/affiliateOrderMessages";

// Live feed: the gap BETWEEN background polls (measured after the previous poll
// finishes, so requests can never stack up). ~3s gives near-instant sale
// appearance while keeping load bounded — one poll at a time, paused when the
// tab is hidden. Reuses the interval-polling approach already used elsewhere.
const LIVE_POLL_MS = 3000;

// Identity verification status → French label + emoji + colour (single source).
const IDENTITY_UI = {
  NOT_SUBMITTED: { emoji: "🪪", label: "Identité non vérifiée",  color: "#6b7280", bg: "#f3f4f6" },
  PENDING:       { emoji: "🟡", label: "Vérification en cours",   color: "#b45309", bg: "#fffbeb" },
  APPROVED:      { emoji: "✅", label: "Identité vérifiée",       color: "#047857", bg: "#ecfdf5" },
  REJECTED:      { emoji: "❌", label: "Vérification refusée",    color: "#b91c1c", bg: "#fef2f2" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  return `${Number(n).toFixed(0)} MAD`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", {
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
  pending:   { label: "En attente",  cls: "bg-yellow-100 text-yellow-700" },
  confirmed: { label: "Confirmée",   cls: "bg-blue-100   text-blue-700"   },
  shipped:   { label: "En livraison",cls: "bg-purple-100 text-purple-700" },
  delivered: { label: "Livrée",      cls: "bg-green-100  text-green-700"  },
  cancelled: { label: "Annulée",     cls: "bg-red-100    text-red-700"    },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || { label: status, cls: "bg-gray-100 text-gray-600" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.cls}`}>{cfg.label}</span>;
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
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-gray-700">Parrainages valides</span>
        <span className="font-bold text-gray-900">{validReferrals} / {target}</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-blue-500 to-blue-600 rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span className="font-medium text-blue-600">{progress}% complété</span>
        {remaining > 0 ? (
          <span>{remaining} parrainage{remaining !== 1 ? "s" : ""} valide{remaining !== 1 ? "s" : ""} restant{remaining !== 1 ? "s" : ""}</span>
        ) : (
          <span className="text-green-600 font-semibold">✓ Objectif atteint !</span>
        )}
      </div>
    </div>
  );
}

// ── Copy helper ───────────────────────────────────────────────────────────────

function CopyButton({ text, label = "Copier" }) {
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
      {copied ? <><Check className="w-3 h-3" />Copié</> : <><Copy className="w-3 h-3" />{label}</>}
    </button>
  );
}

// ── Referral CTA (redesign) ────────────────────────────────────────────────────
// UI only — copies the SAME existing referral link; the % is read live from the
// affiliate's referral commission rate (admin setting), never hardcoded.
function ReferralCta({ link, ratePct }) {
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
      dir="rtl"
      className="max-w-[900px] mx-auto w-full rounded-[24px] bg-[#fdf3e3] border border-amber-100/70 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 px-5 py-5 sm:px-8 sm:py-6"
    >
      <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
        {/* Gift */}
        <div className="w-16 h-16 rounded-2xl bg-white shadow-sm flex items-center justify-center text-3xl shrink-0">🎁</div>
        {/* Center */}
        <div className="flex-1 text-center sm:text-right min-w-0">
          <h3 className="text-base sm:text-lg font-black text-gray-900">شارك رابط الإحالة ديالك</h3>
          <p className="text-sm text-gray-600 mt-0.5">اربح على كل طلب من طرف أي شخص</p>
          <p className="text-xs sm:text-sm text-amber-700 font-bold mt-1.5">
            كتربح {ratePct}% من العمولة على كل طلب جاي من رابطك
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
          {copied ? <>✅ تم نسخ الرابط</> : <><Copy className="w-4 h-4" /> نسخ الرابط</>}
        </button>
      </div>
    </div>
  );
}

// ── Mobile bottom navigation (mobile/tablet only, ≤768px) ──────────────────────
// Additive: the existing desktop header + tab bar are untouched. Reuses the same
// tabs/actions and the SAME referral link (center button copies it, no new URL).
function MobileBottomNav({ activeTab, setActiveTab, refLink, onLogout, unread = 0, onOpenNotifications }) {
  const router = useRouter();
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
    { icon: Package,     label: "الطلبات",        tab: "orders" },
    { icon: Rocket,      label: "Booster",        tab: "booster" },
    { icon: Gift,        label: "المكافآت",       tab: "rewards" },
    { icon: Video,       label: "UGC",            tab: "ugc" },
    { icon: Users,       label: "الفريق",         tab: "team" },
    { icon: Wallet,      label: "الرصيد والسحب",  tab: "payout" },
    { icon: Wallet,      label: "شحن الرصيد",     tab: "deposit" },
    { icon: Building2,   label: "المعلومات البنكية", tab: "bank" },
    { icon: Bell,        label: "الإشعارات",      tab: "notifications", badge: unread },
    { icon: Settings,    label: "الإعدادات",      tab: "settings" },
  ];

  const NavItem = ({ icon: Icon, label, active, onClick, dot }) => (
    <button type="button" onClick={onClick} className="relative flex-1 flex flex-col items-center gap-1 py-1.5 focus:outline-none">
      <span className={`relative flex items-center justify-center w-11 h-8 rounded-2xl transition-all ${active ? "bg-violet-100 text-violet-600" : "text-gray-400"}`}>
        <Icon className="w-[22px] h-[22px]" strokeWidth={active ? 2.5 : 2} />
        {dot > 0 && <span className="absolute -top-0.5 right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{dot > 9 ? "9+" : dot}</span>}
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
          تم نسخ رابط الإحالة ✅
        </div>
      )}

      {/* "المزيد" bottom sheet */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-[70]" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div dir="rtl" onClick={(e) => e.stopPropagation()}
            className="absolute bottom-0 inset-x-0 bg-white rounded-t-[28px] shadow-2xl px-5 pt-4 animate-[bnUp_0.3s_ease]"
            style={{ paddingBottom: "calc(20px + env(safe-area-inset-bottom))" }}>
            <div className="w-10 h-1 rounded-full bg-gray-200 mx-auto mb-4" />
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-black text-gray-900">المزيد</h3>
              <button type="button" onClick={() => setMoreOpen(false)} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {moreItems.map(({ icon: Icon, label, tab, badge }) => (
                <button key={tab} type="button" onClick={() => go(tab)}
                  className={`relative flex flex-col items-center justify-center gap-2 rounded-2xl py-4 px-2 transition-colors ${activeTab === tab ? "bg-violet-50 text-violet-600" : "bg-gray-50 text-gray-600 hover:bg-gray-100"}`}>
                  <Icon className="w-6 h-6" />
                  <span className="text-[11px] font-semibold text-center leading-tight">{label}</span>
                  {badge > 0 && <span className="absolute top-2 left-2 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{badge > 9 ? "9+" : badge}</span>}
                </button>
              ))}
              <button type="button" onClick={() => { setMoreOpen(false); onLogout(); }}
                className="flex flex-col items-center justify-center gap-2 rounded-2xl py-4 px-2 bg-red-50 text-red-600 hover:bg-red-100 transition-colors">
                <LogOut className="w-6 h-6" />
                <span className="text-[11px] font-semibold">تسجيل الخروج</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom nav bar */}
      <nav dir="rtl"
        className="md:hidden fixed bottom-0 inset-x-0 z-[60] bg-white border-t border-gray-100 rounded-t-[28px] shadow-[0_-6px_24px_rgba(0,0,0,0.08)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="flex items-end justify-around px-1.5 pt-2 pb-1">
          <NavItem icon={Home}       label="الرئيسية" active={activeTab === "overview"} onClick={() => go("overview")} />
          <NavItem icon={TrendingUp} label="الأرباح"  active={activeTab === "payout"}   onClick={() => go("payout")} />

          {/* Center floating action — copies the referral link */}
          <div className="flex-1 flex flex-col items-center">
            <button type="button" onClick={share} aria-label="مشاركة رابط الإحالة"
              className="-mt-7 w-14 h-14 rounded-full bg-violet-600 hover:bg-violet-700 active:scale-90 text-white shadow-lg shadow-violet-300 flex items-center justify-center transition-all">
              <Plus className="w-7 h-7" strokeWidth={2.5} />
            </button>
            <span className="text-[10px] font-bold text-violet-600 mt-1">مشاركة رابط</span>
          </div>

          <NavItem icon={ShoppingBag}    label="المنتجات" active={false}                onClick={() => router.push("/products")} />
          <NavItem icon={MoreHorizontal} label="المزيد"   active={moreOpen}             onClick={() => setMoreOpen(true)} dot={unread} />
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

function productPreview(order) {
  const items = order.orderItems;
  if (!items || items.length === 0) return order.productTitle || '—';
  if (items.length === 1) {
    const { productName, quantity } = items[0];
    return quantity > 1 ? `${productName} ×${quantity}` : (productName || order.productTitle || '—');
  }
  const { productName, quantity } = items[0];
  const rest = items.length - 1;
  return `${productName} ×${quantity} + ${rest} autre${rest > 1 ? 's' : ''}`;
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
            <h3 className="text-sm font-bold text-gray-900">Détails de la commande</h3>
            <p className="text-xs text-gray-400 font-mono mt-0.5">
              {order.orderId ? `#${order.orderId.slice(0, 8).toUpperCase()}` : 'ID non lié'}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
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
                <span className="text-[10px] text-gray-400">{fmtDate(order.createdAt)}</span>
              </div>
            </div>

            {/* Phone + action buttons — Part 3 & 4 */}
            {phone && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-gray-600 bg-gray-100 px-2.5 py-1 rounded-lg">
                  {phone}
                </span>
                <a
                  href={`tel:${phone}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors"
                >
                  📞 Appeler
                </a>
                <a
                  href={`https://wa.me/${waPhone}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white text-xs font-semibold rounded-xl transition-colors"
                >
                  💬 WhatsApp
                </a>
              </div>
            )}
          </div>

          {/* Products list */}
          <div className="px-5 pt-4 pb-2">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">
              📦 Produits
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
                      <p className="text-xs text-gray-400 mt-0.5">×{item.quantity} — {fmtMoney(item.price)} / u</p>
                    </div>
                    <p className="text-sm font-bold text-gray-800 whitespace-nowrap shrink-0">
                      {fmtMoney(item.price * item.quantity)}
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
              <span className="text-sm font-bold text-gray-900">Total commande</span>
              <span className="text-base font-black text-gray-900">{fmtMoney(order.total)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Commission affilié</span>
              <span className="text-sm font-bold text-green-700">{fmtMoney(order.commissionAmount)}</span>
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
                {updatingOrder === order.id ? '...' : '✅ Confirmer'}
              </button>
            )}
            <button
              onClick={() => { onStatusChange(order.id, 'cancelled'); onClose(); }}
              disabled={updatingOrder === order.id}
              className="flex-1 py-2.5 bg-red-50 hover:bg-red-100 text-red-700 text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
            >
              ❌ Annuler
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Avatar Upload Component ───────────────────────────────────────────────────

function AvatarUpload({ affiliate, authHeaders, onUpdate }) {
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
      if (!res.ok) { alert(json.error || "Erreur upload"); setPreview(null); return; }
      onUpdate(json.affiliate);
    } catch { alert("Erreur réseau"); setPreview(null); }
    finally  { setUploading(false); }
  };

  const current = preview || affiliate?.avatarUrl;

  return (
    <div className="flex items-center gap-5">
      {/* Avatar preview */}
      <div className="relative w-20 h-20 rounded-2xl overflow-hidden bg-gray-100 flex-shrink-0 border border-gray-200">
        {current ? (
          <img src={current} alt="avatar" className="w-full h-full object-cover" />
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
          {uploading ? "Téléversement…" : "Changer la photo"}
        </button>
        <p className="text-xs text-gray-400">JPG, PNG — max 2 Mo</p>
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

// ── Demo Competition helpers ──────────────────────────────────────────────────

const RANK_MEDALS  = ['🥇', '🥈', '🥉'];
// UI-only: hide the internal demo_ prefix from competition usernames.
// Strips a single leading "demo_"; all other usernames are returned unchanged.
const displayUsername = (u) => (u || "").replace(/^demo_/, "");
const GROWTH_BADGE = {
  aggressive: { label: 'Top Performer',  cls: 'bg-red-100 text-red-700'    },
  consistent: { label: 'Régulier ⚡',    cls: 'bg-blue-100 text-blue-700'  },
  slow:       { label: 'En croissance',  cls: 'bg-gray-100 text-gray-600'  },
};

function DemoAvatar({ name, color, url, size = 'md' }) {
  const sz = size === 'lg' ? 'w-14 h-14 text-xl' : size === 'sm' ? 'w-7 h-7 text-xs' : 'w-10 h-10 text-sm';
  const [broken, setBroken] = useState(false);
  // Persisted uploaded avatar when available; on load error (e.g. deleted from the
  // library) gracefully fall back to the initials avatar — never a broken image.
  if (url && !broken) {
    return (
      <img src={url} alt={name || ''} onError={() => setBroken(true)}
        className={`${sz} rounded-full object-cover shrink-0 bg-gray-200`} />
    );
  }
  return (
    <div className={`${sz} rounded-full flex items-center justify-center font-black text-white shrink-0`}
      style={{ background: color }}>
      {(name || '?')[0].toUpperCase()}
    </div>
  );
}

// ── Demo Affiliate Detail Modal ───────────────────────────────────────────────

function DemoAffiliateModal({ affiliateId, onClose }) {
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    if (!affiliateId) return;
    setLoading(true);
    fetch(`/api/demo/affiliate/${affiliateId}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [affiliateId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}>

      <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden
        animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-800">
            {'Profil compétiteur'}
          </h2>
          <button onClick={onClose}
            className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 transition-colors">
            <XCircle className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-gray-300" />
          </div>
        ) : !data ? (
          <p className="text-center text-sm text-gray-400 py-12">
            {'Données introuvables'}
          </p>
        ) : (
          <div className="flex flex-col max-h-[80vh]">

            {/* Identity strip */}
            <div className="flex items-center gap-3 px-5 py-4 bg-gradient-to-r from-gray-50 to-white border-b border-gray-100">
              <DemoAvatar name={data.name} color={data.avatarColor} url={data.avatarUrl} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-black text-gray-900 text-base truncate">{data.name}</p>
                  {data.rank <= 3 && <span className="text-xl">{RANK_MEDALS[data.rank - 1]}</span>}
                </div>
                <p className="text-xs text-gray-400 font-mono">@{displayUsername(data.username)}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-gray-900 text-white">
                    #{data.rank} {'classement'}
                  </span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${GROWTH_BADGE[data.growthType]?.cls}`}>
                    {GROWTH_BADGE[data.growthType]?.label}
                  </span>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-100 bg-gray-50">
              {[
                { id: 'overview', label: 'Aperçu' },
                { id: 'team',     label: 'Équipe'    },
                { id: 'earnings', label: 'Gains'   },
              ].map((t) => (
                <button key={t.id} onClick={() => setActiveTab(t.id)}
                  className={`flex-1 py-2.5 text-xs font-semibold transition-colors border-b-2
                    ${activeTab === t.id
                      ? 'border-gray-900 text-gray-900 bg-white'
                      : 'border-transparent text-gray-400 hover:text-gray-700'}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1">

              {/* ── OVERVIEW ── */}
              {activeTab === 'overview' && (
                <div className="p-4 space-y-4">
                  {/* Main stats */}
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: 'Commandes totales', value: data.totalOrders,     color: 'text-gray-800' },
                      { label: 'CA total (MAD)', value: `${Math.round(data.totalRevenue).toLocaleString()} MAD`, color: 'text-amber-700' },
                      { label: 'Confirmées',           value: data.confirmedOrders, color: 'text-green-700' },
                      { label: 'Annulées',            value: data.cancelledOrders, color: 'text-red-600'   },
                    ].map((s) => (
                      <div key={s.label} className="bg-gray-50 rounded-xl p-3 border border-gray-100">
                        <p className={`text-lg font-black ${s.color}`}>{s.value}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5">{s.label}</p>
                      </div>
                    ))}
                  </div>

                  {/* Today */}
                  <div className="bg-indigo-50 rounded-xl p-3.5 border border-indigo-100">
                    <p className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider mb-2">
                      {"Aujourd'hui"}
                    </p>
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-2xl font-black text-indigo-800">{data.todayOrders}</p>
                        <p className="text-[10px] text-indigo-400">{'commandes'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xl font-black text-indigo-700">
                          {Math.round(data.todayRevenue).toLocaleString()} MAD
                        </p>
                        <p className="text-[10px] text-indigo-400">{'CA aujourd\'hui'}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── TEAM ── */}
              {activeTab === 'team' && (
                <div className="p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: 'Taille équipe',        value: data.teamSize,       color: 'text-purple-700' },
                      { label: 'Cmds équipe',      value: data.teamOrders,     color: 'text-gray-800'   },
                      { label: 'CA équipe (MAD)',    value: `${Math.round(data.teamRevenue).toLocaleString()} MAD`, color: 'text-amber-700'  },
                      { label: 'Ta commission 5%',         value: `${Math.round(data.teamCommission).toLocaleString()} MAD`, color: 'text-green-700' },
                    ].map((s) => (
                      <div key={s.label} className="bg-gray-50 rounded-xl p-3 border border-gray-100">
                        <p className={`text-lg font-black ${s.color}`}>{s.value}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5">{s.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── GAINS (UGC) — demo UGC stats only; Boutique stays in Aperçu ── */}
              {activeTab === 'earnings' && (
                <div className="p-4">
                  <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider mb-3">
                    {'Gains UGC (vidéos)'}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: "Gains UGC aujourd'hui",  value: `${Math.round(data.ugcTodayEarnings ?? 0).toLocaleString()} MAD`, color: 'text-violet-700' },
                      { label: "Ventes UGC aujourd'hui", value: data.ugcTodaySales ?? 0, color: 'text-violet-700' },
                      { label: 'Gains UGC total', value: `${Math.round(data.ugcTotalEarnings ?? 0).toLocaleString()} MAD`, color: 'text-emerald-700' },
                      { label: 'Ventes UGC total', value: data.ugcTotalSales ?? 0, color: 'text-emerald-700' },
                    ].map((s) => (
                      <div key={s.label} className="bg-violet-50 rounded-xl p-3 border border-violet-100">
                        <p className={`text-lg font-black ${s.color}`}>{s.value}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">{s.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Competition Tab ───────────────────────────────────────────────────────────

const REFRESH_SEC = 15;

function CompetitionTab() {
  const [leaderboard,  setLeaderboard]  = useState([]);
  const [competition,  setCompetition]  = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [selectedId,   setSelectedId]   = useState(null);
  const [rankDeltas,   setRankDeltas]   = useState({}); // id → delta (+up / -down)
  const [flashMap,     setFlashMap]     = useState({}); // id → 'up'|'down'|'new'
  const [countdown,    setCountdown]    = useState(REFRESH_SEC);
  const prevRankRef  = useRef({});   // id → last index
  const deltaTimerRef = useRef(null);
  const flashTimerRef = useRef(null);

  const applyNewBoard = useCallback((newBoard) => {
    const prevMap = prevRankRef.current;
    const deltas  = {};
    const flash   = {};

    newBoard.forEach((a, i) => {
      const prev = prevMap[a.id];
      if (prev === undefined) {
        flash[a.id] = 'new';
      } else if (prev !== i) {
        deltas[a.id] = prev - i;           // positive → moved up
        flash[a.id]  = prev > i ? 'up' : 'down';
      }
    });

    // Persist new positions
    const newMap = {};
    newBoard.forEach((a, i) => { newMap[a.id] = i; });
    prevRankRef.current = newMap;

    setLeaderboard(newBoard);
    setRankDeltas(deltas);
    setFlashMap(flash);

    // Auto-clear flash after 2 s, deltas after 5 s
    clearTimeout(flashTimerRef.current);
    clearTimeout(deltaTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashMap({}),   2000);
    deltaTimerRef.current = setTimeout(() => setRankDeltas({}), 5000);
  }, []);

  const fetchBoard = useCallback(async (initial = false) => {
    try {
      const r = await fetch('/api/demo/leaderboard?limit=20');
      const d = await r.json();
      applyNewBoard(d.leaderboard || []);
      setCompetition(d.competition || null);
    } catch {}
    if (initial) setLoading(false);
  }, [applyNewBoard]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchBoard(true);
    return () => {
      clearTimeout(flashTimerRef.current);
      clearTimeout(deltaTimerRef.current);
    };
  }, [fetchBoard]);

  // Auto-refresh every REFRESH_SEC seconds + live countdown
  useEffect(() => {
    setCountdown(REFRESH_SEC);
    const tick = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchBoard(false);
          return REFRESH_SEC;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [fetchBoard]);

  const daysLeft = competition?.daysLeft ?? 0;

  return (
    <>
      {/* Inject keyframes for flash animations */}
      <style>{`
        @keyframes flashUp   { 0%,100%{background:transparent} 30%{background:#dcfce7} }
        @keyframes flashDown { 0%,100%{background:transparent} 30%{background:#fee2e2} }
        @keyframes flashNew  { 0%,100%{background:transparent} 30%{background:#ede9fe} }
        .flash-up   { animation: flashUp   2s ease forwards }
        .flash-down { animation: flashDown 2s ease forwards }
        .flash-new  { animation: flashNew  2s ease forwards }
      `}</style>

    <div className="space-y-4">

      {/* ── Competition banner ── */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%)' }}>
        <div className="px-5 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-indigo-300 text-xs font-semibold uppercase tracking-widest mb-1">
                {`Cycle #${competition?.cycleNum ?? 1}`}
              </p>
              <h2 className="text-white text-xl font-black">
                {'🏆 Compétition du mois'}
              </h2>
              <p className="text-indigo-300 text-xs mt-1">
                {`${competition?.totalParticipants ?? 0} participants · ${daysLeft} jours restants`}
              </p>
            </div>
            <div className="text-center">
              <p className="text-4xl font-black text-white">{daysLeft}</p>
              <p className="text-indigo-300 text-xs">{'jours'}</p>
            </div>
          </div>
          {competition && (() => {
            const elapsed = 30 - daysLeft;
            const pct = Math.round((elapsed / 30) * 100);
            return (
              <div className="mt-3 bg-indigo-900/60 rounded-full h-1.5">
                <div className="bg-indigo-400 h-1.5 rounded-full transition-all duration-1000" style={{ width: `${pct}%` }} />
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Leaderboard ── */}
      <Section
        title={
          <div className="flex items-center justify-between w-full">
            <span>{'Classement du mois'}</span>
            <span className="flex items-center gap-1.5 text-[10px] font-semibold text-gray-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              {`Live · ${countdown}s`}
            </span>
          </div>
        }
        icon={TrendingUp}
      >
        {loading ? (
          <div className="flex items-center justify-center py-10 gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            <span className="text-sm text-gray-400">{'Chargement...'}</span>
          </div>
        ) : leaderboard.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 text-sm">
              {"Aucun participant pour l'instant."}
            </p>
            <p className="text-gray-400 text-xs mt-1">
              {'Activez la compétition depuis le panneau admin.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {leaderboard.map((a, i) => {
              const delta     = rankDeltas[a.id] ?? 0;
              const flash     = flashMap[a.id];
              const flashCls  = flash === 'up' ? 'flash-up' : flash === 'down' ? 'flash-down' : flash === 'new' ? 'flash-new' : '';
              const baseBg    = i === 0 ? 'bg-amber-50 border-amber-200 shadow-sm shadow-amber-100'
                              : i === 1 ? 'bg-gray-50 border-gray-200'
                              : i === 2 ? 'bg-orange-50 border-orange-200'
                              : 'bg-white border-gray-100';
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedId(a.id)}
                  className={`${flashCls} w-full text-left flex items-center gap-3 px-3.5 py-3 rounded-xl border transition-all duration-500 hover:shadow-sm active:scale-[0.99] ${baseBg}`}
                >
                  {/* Rank number */}
                  <div className="w-7 text-center shrink-0">
                    {i < 3
                      ? <span className="text-xl">{RANK_MEDALS[i]}</span>
                      : <span className="text-xs font-black text-gray-400">#{i + 1}</span>}
                  </div>

                  {/* Avatar */}
                  <DemoAvatar name={a.name} color={a.avatarColor} url={a.avatarUrl} size="sm" />

                  {/* Name + badge + delta */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-sm font-bold text-gray-800 truncate">{a.name}</p>
                      {a.growthType === 'aggressive' && (
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 whitespace-nowrap">
                          Top 🔥
                        </span>
                      )}
                      {/* Rank movement badge */}
                      {delta !== 0 && (
                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full whitespace-nowrap
                          ${delta > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {delta > 0 ? `▲ +${delta}` : `▼ ${delta}`}
                        </span>
                      )}
                      {flash === 'new' && (
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 whitespace-nowrap">
                          Nouveau
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-gray-400 font-mono">@{displayUsername(a.username)}</p>
                  </div>

                  {/* Stats */}
                  <div className="text-right shrink-0">
                    <p className="text-sm font-black text-gray-800">
                      {a.totalOrders}
                      <span className="text-xs font-normal text-gray-400 ml-1">{'cmds'}</span>
                    </p>
                    <p className="text-xs text-amber-700 font-bold">{Math.round(a.totalRevenue).toLocaleString()} MAD</p>
                  </div>

                  <ChevronDown className="w-4 h-4 text-gray-300 -rotate-90 shrink-0" />
                </button>
              );
            })}
          </div>
        )}
        <p className="text-xs text-gray-400 mt-3">
          {'Mise à jour automatique toutes les 15 s. Cliquez pour les détails.'}
        </p>
      </Section>

      {/* ── Detail modal ── */}
      {selectedId && (
        <DemoAffiliateModal
          affiliateId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  </>
  );
}

// ── Identity Verification card (Settings) ─────────────────────────────────────
const CIN_ACCEPT = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const CIN_MAX = 5 * 1024 * 1024;

function CinField({ label, side, file, preview, onPick, onClear, disabled }) {
  const inputId = `cin-${side}`;
  return (
    <div>
      <p className="text-xs font-semibold text-gray-600 mb-1.5">{label}</p>
      {preview ? (
        <div className="relative border border-gray-200 rounded-xl overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={label} className="w-full h-40 object-contain bg-gray-100" />
          {!disabled && (
            <button type="button" onClick={onClear}
              className="absolute top-2 right-2 bg-white/90 hover:bg-white p-1.5 rounded-lg text-red-600 shadow">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ) : (
        <label htmlFor={inputId}
          className={`flex flex-col items-center justify-center h-40 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${disabled ? "opacity-50 pointer-events-none" : "border-gray-200 hover:border-indigo-300 bg-gray-50"}`}>
          <Upload className="w-5 h-5 text-gray-400 mb-1" />
          <span className="text-xs text-gray-500">JPG, PNG, WEBP · max 5 Mo</span>
        </label>
      )}
      <input id={inputId} type="file" accept={CIN_ACCEPT.join(",")} className="hidden" disabled={disabled}
        onChange={(e) => onPick(e.target.files?.[0] || null)} />
    </div>
  );
}

function IdentityVerificationCard({ token, status, identity, onDone }) {
  const [front, setFront]       = useState(null);
  const [back, setBack]         = useState(null);
  const [frontPrev, setFrontPrev] = useState(null);
  const [backPrev, setBackPrev]   = useState(null);
  const [err, setErr]           = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);

  const locked = status === "APPROVED";
  const ui = IDENTITY_UI[status] || IDENTITY_UI.NOT_SUBMITTED;

  const validate = (f) => {
    if (!f) return null;
    if (!CIN_ACCEPT.includes(f.type)) return "Format non supporté (JPG, PNG ou WEBP).";
    if (f.size > CIN_MAX) return "Fichier trop volumineux (max 5 Mo).";
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
        let m = "Échec de l'envoi.";
        try { m = JSON.parse(xhr.responseText)?.error || m; } catch {}
        setErr(m);
      }
    };
    xhr.onerror = () => { setSubmitting(false); setErr("Erreur réseau."); };
    xhr.send(fd);
  };

  return (
    <Section title="Vérification d'identité" icon={ShieldCheck}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold"
            style={{ color: ui.color, background: ui.bg }}>
            <span>{ui.emoji}</span> {ui.label}
          </span>
        </div>

        <p className="text-xs text-gray-500">
          Pour sécuriser votre compte et débloquer les retraits, veuillez envoyer une pièce d'identité valide.
        </p>

        {status === "APPROVED" ? (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3">
            ✅ Identité vérifiée{identity?.approvedAt ? ` le ${fmtDate(identity.approvedAt)}` : ""}. Vos documents sont verrouillés.
          </div>
        ) : status === "PENDING" ? (
          <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3">
            🟡 Votre vérification est en cours d'examen. Vous serez notifié après la décision.
          </div>
        ) : (
          <>
            {status === "REJECTED" && identity?.rejectionReason && (
              <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-3">
                ❌ Refusée — motif : {identity.rejectionReason}. Vous pouvez renvoyer de nouvelles images.
              </div>
            )}
            {err && <div className="rounded-lg bg-red-50 text-red-700 text-xs px-3 py-2">{err}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <CinField label="Recto de la CIN" side="front" file={front} preview={frontPrev} onPick={pick("front")} onClear={clear("front")} disabled={locked || submitting} />
              <CinField label="Verso de la CIN" side="back" file={back} preview={backPrev} onPick={pick("back")} onClear={clear("back")} disabled={locked || submitting} />
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
              {submitting ? `Envoi… ${progress}%` : "Envoyer pour vérification"}
            </button>
          </>
        )}
      </div>
    </Section>
  );
}

function WhatsappSupportCard({ link }) {
  return (
    <Section title="Support WhatsApp" icon={MessageCircle}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">Notre équipe est disponible pour vous aider concernant :</p>
        <ul className="text-xs text-gray-600 grid grid-cols-2 gap-1.5">
          {["Commandes", "Commissions", "Retraits", "Vérification d'identité", "UGC", "Compétition", "Problèmes techniques"].map((t) => (
            <li key={t} className="flex items-center gap-1.5"><span className="text-green-500">•</span>{t}</li>
          ))}
        </ul>
        <a href={link} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-semibold">
          <MessageCircle className="w-4 h-4" /> Contacter le support WhatsApp
        </a>
      </div>
    </Section>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function AffiliateDashboard() {
  const router = useRouter();

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
  const [error,      setError]      = useState(null);

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
    const t = localStorage.getItem("affiliateToken") || "";
    fetch("/api/affiliate/boosters", { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" })
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
  const { lang } = useLanguage();
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
      else setError("Impossible de charger les données. Réessayez.");
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
      willExpand ? next.add(memberId) : next.delete(memberId);
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
        setBankError(d.error || "Erreur");
      }
    } catch {
      setBankError("Erreur réseau");
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
        setPayoutMsg({ type: "success", text: "Demande de retrait envoyée avec succès !" });
        setPayoutAmount("");
        fetchAll(token);
      } else {
        setPayoutMsg({ type: "error", text: d.error || "Erreur" });
      }
    } catch {
      setPayoutMsg({ type: "error", text: "Erreur réseau" });
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
          <p className="text-gray-700 text-sm">{error}</p>
          <button onClick={() => fetchAll(token)} className="px-6 py-2 bg-gray-900 text-white rounded-xl text-sm font-semibold">
            Réessayer
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
  const goToDeposit = () => setActiveTab("deposit");

  // Security deposit — SEPARATE from Solde disponible (never withdrawable).
  const deposit = data?.deposit || { approvedBalance: 0, pendingTotal: 0 };

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
    { id: "overview",      label: "Vue d'ensemble" },
    { id: "orders",        label: `Commandes (${orders.length})` },
    { id: "bank",          label: "Coordonnées" },
    { id: "payout",        label: "Retraits" },
    { id: "deposit",       label: "💰 Dépôt de solde" },
    { id: "booster",       label: "🚀 Booster" },
    { id: "rewards",       label: "🎁 Récompenses" },
    { id: "ugc",           label: "💰 Video UGC" },
    { id: "notifications", label: `Notifs ${unread > 0 ? `(${unread})` : ""}` },
    { id: "team",          label: `Équipe (${team.length})` },
    { id: "settings",      label: "Paramètres" },
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
              title="Paramètres"
            >
              {affiliate?.avatarUrl ? (
                <img src={affiliate.avatarUrl} alt="avatar"
                  className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                  <Users className="w-4 h-4 text-white" />
                </div>
              )}
            </button>
            <div className="hidden sm:block">
              <p className="text-sm font-bold text-gray-900 leading-none">Tableau de bord</p>
              <p className="text-xs text-gray-500">@{affiliate?.username}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* WhatsApp quick support — shown only when enabled + configured */}
            {supportLink && (
              <a
                href={supportLink}
                target="_blank"
                rel="noopener noreferrer"
                title="Support WhatsApp"
                className="p-2 rounded-xl transition-colors text-green-600 hover:text-green-700 hover:bg-green-50"
              >
                <MessageCircle className="w-4 h-4" />
              </a>
            )}

            {/* Notifications bell */}
            <button
              onClick={() => { setActiveTab("notifications"); markNotifsRead(); }}
              className="relative p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-xl transition-colors"
            >
              <Bell className="w-4 h-4" />
              {unread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </button>

            {/* Live indicator — green pulse when the background feed is healthy,
                amber when the last poll failed (auto-reconnects next tick). */}
            <span
              title={liveConnected ? "En direct" : "Reconnexion…"}
              className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold"
              style={{ color: liveConnected ? "#059669" : "#b45309", background: liveConnected ? "#ecfdf5" : "#fffbeb" }}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${liveConnected ? "animate-pulse" : ""}`}
                style={{ background: liveConnected ? "#10b981" : "#f59e0b" }}
              />
              {liveConnected ? "Live" : "…"}
            </span>

            {/* Refresh (manual fallback — always available) */}
            <button
              onClick={() => fetchAll(token)}
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
              title="Paramètres"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* Logout */}
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded-xl transition-colors font-semibold"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Déconnexion</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5 space-y-5 pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-5">

        {/* ── Tab nav ── */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`whitespace-nowrap px-4 py-2 rounded-xl text-xs font-semibold transition-colors
                ${activeTab === t.id
                  ? "bg-gray-900 text-white"
                  : "bg-white border border-gray-200 text-gray-600 hover:border-gray-400"}`}
            >
              {t.label}
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

                {/* Left: greeting + reward */}
                <div className="flex items-center gap-3">
                  <span className="text-4xl select-none">🏆</span>
                  <div>
                    <p className="text-xs opacity-80">Bonjour, {affiliate.name || affiliate.username}</p>
                    <h3 className="text-sm font-bold md:text-base">
                      Gagnez {((affiliate.commissionRate || 0) * 100).toFixed(0)}% sur chaque commande livrée
                    </h3>
                  </div>
                </div>

                {/* Right: progress bars */}
                <div className="flex w-full flex-col gap-2 self-start lg:w-auto lg:min-w-72">
                  <div className="flex items-center justify-between text-xs font-medium opacity-80">
                    <span>Votre progression</span>
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.43 5.93L20.5 12l-6.07 6.07M3.5 12h16.83"/>
                    </svg>
                  </div>

                  {/* Orders progress */}
                  <div>
                    <p className="mb-1.5 text-xs font-bold">
                      {stats?.validReferrals ?? 0} / {gami?.target || 5} parrainages valides
                    </p>
                    <div className="w-full overflow-hidden rounded-full h-2" style={{ background: "rgba(255,255,255,0.25)" }}>
                      <div className="h-full rounded-full bg-white transition-all duration-700"
                        style={{ width: `${gami?.progress || 0}%` }} />
                    </div>
                  </div>

                  {/* Orders objective — counts delivered orders only (same basis as commissions) */}
                  <div>
                    <p className="mb-1.5 text-xs font-bold">
                      {affiliate?.deliveredOrdersCount ?? 0} / {affiliate?.goalOrders || 5} commandes
                    </p>
                    <div className="w-full overflow-hidden rounded-full h-2" style={{ background: "rgba(255,255,255,0.25)" }}>
                      <div className="h-full rounded-full bg-white transition-all duration-700"
                        style={{ width: `${Math.min(100, ((affiliate?.deliveredOrdersCount ?? 0) / (affiliate?.goalOrders || 5)) * 100)}%` }} />
                    </div>
                  </div>

                  {/* UGC validated videos — click → UGC page. Only admin-approved
                      (APPROVED/RUNNING) videos count; pending/rejected excluded. */}
                  <button onClick={goToUgc} title="Vidéos UGC validées" className="block w-full text-left">
                    <p className="mb-1.5 text-xs font-bold flex items-center justify-between gap-2">
                      <span>🎬 {ugcValidated} / {ugcGoal} vidéos UGC validées</span>
                      <svg className="w-3.5 h-3.5 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                    </p>
                    <div className="w-full overflow-hidden rounded-full h-2" style={{ background: "rgba(255,255,255,0.25)" }}>
                      <div className="h-full rounded-full bg-white transition-all duration-700"
                        style={{ width: `${Math.min(100, (ugcValidated / Math.max(1, ugcGoal)) * 100)}%` }} />
                    </div>
                  </button>

                  {/* Identity verification condition — click → Paramètres → Vérification */}
                  <button
                    onClick={goToIdentity}
                    title="Vérification d'identité"
                    className="mt-1 flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors"
                    style={{ background: "rgba(255,255,255,0.18)" }}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-bold">
                      <span>{IDENTITY_UI[identityStatus].emoji}</span>
                      <span>{IDENTITY_UI[identityStatus].label}</span>
                    </span>
                    <svg className="w-3.5 h-3.5 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                  </button>
                </div>
              </div>
            )}

            {/* ── BOUTIQUE (store / order) earnings — unchanged calculations ── */}
            <div className="flex items-center gap-2 px-0.5">
              <ShoppingBag className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-bold text-gray-700">Boutique (commandes)</h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <StatCard icon={ShoppingBag} label="Commandes boutique aujourd'hui" value={stats?.todaySales  ?? "—"} color="blue"   />
              <StatCard icon={CheckCircle} label="Confirmées"           value={stats?.confirmed   ?? "—"} color="green"  />
              <StatCard icon={XCircle}     label="Annulées"             value={stats?.cancelled   ?? "—"} color="red"    />
              <StatCard icon={Truck}       label="En livraison"         value={stats?.shipping    ?? "—"} color="purple" />
              <StatCard icon={Package}     label="Livrées"              value={stats?.delivered   ?? "—"} color="teal"   />
              <StatCard icon={TrendingUp}  label="Chiffre d'affaires boutique" value={fmtMoney(stats?.totalRevenue)} color="amber" />
              <StatCard icon={DollarSign}  label="Gains boutique total" value={fmtMoney(stats?.totalCommission)} color="green"
                sub={`Taux : ${((affiliate?.commissionRate || 0) * 100).toFixed(0)}%`} />
              <StatCard icon={CreditCard}  label="Solde disponible"     value={fmtMoney(balance)}                color="blue"   />
              {/* Tracking stats */}
              <StatCard icon={Eye}         label="Total clics"          value={stats?.totalClicks ?? affiliate?.totalClicks ?? "—"} color="blue"   />
              <StatCard icon={ShoppingBag} label="Ventes boutique total" value={orders.length > 0 ? totalItemsAll : (stats?.totalOrders ?? affiliate?.totalOrders ?? "—")} color="teal" sub="articles commandés" />
              <StatCard icon={TrendingUp}  label="Taux de conversion"   value={stats?.conversionRate != null ? `${stats.conversionRate}%` : "—"} color="amber"
                sub="commandes / clics" />
              <StatCard icon={Users}       label="Commission Équipe"    value={fmtMoney(stats?.teamCommission)} color="teal"
                sub={`${team.length} membre${team.length !== 1 ? "s" : ""}`} />
            </div>

            {/* 🚀 Active Booster widget → opens the Booster page */}
            {activeBoosters.map((b) => (
              <button key={b.id} onClick={() => setActiveTab("booster")} className="w-full text-left">
                <div dir="rtl" className="rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white p-4 hover:brightness-110 transition-all">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-black">🚀 {b.packageName}</span>
                    <span className="text-[11px] font-bold bg-white/15 rounded-full px-2 py-0.5">
                      {b.daysLeft != null ? `ينتهي بعد ${b.daysLeft} يوم` : "نشطة"}
                    </span>
                  </div>
                  {b.target ? (
                    <>
                      <div className="mt-3 h-2.5 rounded-full bg-white/20 overflow-hidden">
                        <div className="h-full rounded-full bg-white transition-all duration-700" style={{ width: `${b.percent ?? 0}%` }} />
                      </div>
                      <div className="flex items-center justify-between mt-1.5 text-xs font-black">
                        <span>{b.sales} / {b.target}</span>
                        <span>{b.percent ?? 0}%</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs opacity-80 mt-2">{b.sales} مبيعات منذ التفعيل</p>
                  )}
                </div>
              </button>
            ))}

            {/* ── 💰 Dépôt de solde — balance top-up (credited after validation) ── */}
            <button onClick={goToDeposit} className="w-full text-left">
              <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 flex items-center justify-between gap-3 hover:bg-indigo-50 transition-colors">
                <div>
                  <div className="flex items-center gap-2 text-indigo-700 text-xs font-semibold">
                    <Wallet className="w-4 h-4" /> 💰 Dépôt de solde
                  </div>
                  <p className="text-2xl font-black text-gray-900 mt-1">{fmtMoney(deposit.approvedBalance)}</p>
                  {deposit.pendingTotal > 0 && (
                    <p className="text-[11px] font-semibold text-amber-600 mt-0.5">
                      En attente de validation : {fmtMoney(deposit.pendingTotal)}
                    </p>
                  )}
                  <p className="text-[10px] text-gray-400 mt-0.5">Rechargez votre solde disponible · crédité après validation</p>
                </div>
                <svg className="w-4 h-4 text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            </button>

            {/* ── UGC (simulated video sales) — separate source, never mixed ── */}
            <div className="flex items-center gap-2 px-0.5 pt-1">
              <Video className="w-4 h-4 text-violet-500" />
              <h2 className="text-sm font-bold text-gray-700">UGC (vidéos)</h2>
              <span className="px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[10px] font-bold">UGC</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <StatCard icon={Wallet}      label="Gains UGC aujourd'hui"  value={fmtMoney(ugcStats?.todayEarnings)} color="purple" sub="UGC" />
              <StatCard icon={Video}       label="Ventes UGC aujourd'hui" value={ugcStats?.todaySales ?? "—"}       color="purple" sub="UGC" />
              <StatCard icon={DollarSign}  label="Gains UGC total"        value={fmtMoney(ugcStats?.totalEarnings)} color="purple" sub="UGC" />
              <StatCard icon={TrendingUp}  label="Ventes UGC total"       value={ugcStats?.totalSales ?? "—"}       color="purple" sub="UGC" />
            </div>

            {/* 🔥 النشاط المباشر — same shared server-side Live Activity engine as
                the landing page (GET /api/live-activity). Placed below the stats. */}
            <LiveActivity windowSize={4} showViewAll />

            {/* 🏆 Compétition du mois — moved here (where the bonus block used to be).
                Same component reused inline; the standalone tab has been removed. */}
            <CompetitionTab />

            {/* Referral CTA (kept directly below the competition) */}
            <ReferralCta link={refLink} ratePct={((affiliate?.commissionRate || 0) * 100).toFixed(0)} />

            {/* Last 5 orders */}
            {orders.length > 0 && (
              <Section title="Dernières commandes" icon={ShoppingBag}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        {["ID","Client","Nb articles","Produit","Statut","Total","Commission","Date","Voir"].map((h) => (
                          <th key={h} className="text-left text-xs text-gray-500 font-semibold pb-2 pr-4 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {orders.slice(0, 5).map((o) => (
                        <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                          <td className="py-2.5 pr-4 font-mono text-xs text-gray-400 whitespace-nowrap">
                            {o.orderId ? `#${o.orderId.slice(0, 8).toUpperCase()}` : "—"}
                          </td>
                          <td className="py-2.5 pr-4 text-gray-800 font-medium whitespace-nowrap">{o.clientName || "—"}</td>
                          <td className="py-2.5 pr-4 whitespace-nowrap">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">
                              {o.totalItems > 0 ? o.totalItems : 1}
                            </span>
                          </td>
                          <td className="py-2.5 pr-4 text-gray-600 max-w-[150px] truncate text-xs">{productPreview(o)}</td>
                          <td className="py-2.5 pr-4"><StatusBadge status={o.status} /></td>
                          <td className="py-2.5 pr-4 font-semibold whitespace-nowrap">{fmtMoney(o.total)}</td>
                          <td className="py-2.5 pr-4 text-green-700 font-semibold whitespace-nowrap">{fmtMoney(o.commissionAmount)}</td>
                          <td className="py-2.5 pr-4 text-xs text-gray-400 whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                          <td className="py-2.5">
                            <button
                              onClick={() => setDetailsOrder(o)}
                              className="px-2.5 py-1 bg-gray-100 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-200 transition-colors whitespace-nowrap"
                            >
                              Voir
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {orders.length > 5 && (
                  <button onClick={() => setActiveTab("orders")} className="mt-3 text-xs text-blue-600 font-semibold hover:underline">
                    Voir toutes les commandes →
                  </button>
                )}
              </Section>
            )}
          </div>
        )}

        {/* ══ ORDERS ════════════════════════════════════════════════════════ */}
        {activeTab === "orders" && (
          <Section title="Mes commandes" icon={ShoppingBag}>
            {orders.length === 0 ? (
              <div className="text-center py-10">
                <Package className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">Aucune commande pour l&apos;instant</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      {["ID","Client","Nb cmd","Nb articles","Produit","Statut","Total","Commission","Date","Action"].map((h) => (
                        <th key={h} className="text-left text-xs text-gray-500 font-semibold pb-2.5 pr-4 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {orders.map((o) => (
                      <tr
                        key={o.id}
                        className={`transition-colors ${flashOrderIds.has(String(o._id ?? o.id)) ? "bg-emerald-50 animate-pulse" : "hover:bg-gray-50"}`}
                      >
                        <td className="py-3 pr-4 font-mono text-xs text-gray-400 whitespace-nowrap">
                          {o.orderId ? `#${o.orderId.slice(0, 8).toUpperCase()}` : "—"}
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-gray-800">{o.clientName || "—"}</span>
                            {o.isSuspicious && (
                              <span
                                title={o.suspicionReason || "Activité suspecte détectée"}
                                className="text-amber-500 cursor-help"
                              >
                                <AlertTriangle className="w-3.5 h-3.5" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold ${(phoneCounts[o.clientPhone] || 1) > 1 ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                            {phoneCounts[o.clientPhone] || 1}
                          </span>
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap">
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">
                            {o.totalItems > 0 ? o.totalItems : 1}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-gray-600 max-w-[150px] truncate text-xs">{productPreview(o)}</td>
                        <td className="py-3 pr-4"><StatusBadge status={o.status} /></td>
                        <td className="py-3 pr-4 font-semibold whitespace-nowrap">{fmtMoney(o.total)}</td>
                        <td className="py-3 pr-4 text-green-700 font-semibold whitespace-nowrap">{fmtMoney(o.commissionAmount)}</td>
                        <td className="py-3 pr-4 text-xs text-gray-400 whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                        <td className="py-3">
                          <div className="flex gap-1.5 flex-wrap">
                            {/* Voir — always visible (Part 4) */}
                            <button
                              onClick={() => setDetailsOrder(o)}
                              className="px-2.5 py-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-lg hover:bg-gray-200 transition-colors whitespace-nowrap"
                            >
                              Voir
                            </button>
                            {/* Confirm / Cancel — Part 6: keep unchanged */}
                            {o.status === "pending" && (
                              <button
                                onClick={() => handleOrderStatus(o.id, "confirmed")}
                                disabled={updatingOrder === o.id}
                                className="px-2.5 py-1 bg-blue-50 text-blue-700 text-xs font-semibold rounded-lg hover:bg-blue-100 transition-colors disabled:opacity-50 whitespace-nowrap"
                              >
                                {updatingOrder === o.id ? "..." : "Confirmer"}
                              </button>
                            )}
                            {(o.status === "pending" || o.status === "shipped") && (
                              <button
                                onClick={() => handleOrderStatus(o.id, "cancelled")}
                                disabled={updatingOrder === o.id}
                                className="px-2.5 py-1 bg-red-50 text-red-700 text-xs font-semibold rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50 whitespace-nowrap"
                              >
                                Annuler
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
          <Section title="Coordonnées bancaires" icon={Building2}>
            <form onSubmit={handleBankSave} className="space-y-4 max-w-sm">

              {bankSuccess && (
                <div className="flex items-center gap-2 bg-green-50 border border-green-100 rounded-xl px-4 py-3 text-sm text-green-700">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  Coordonnées enregistrées avec succès !
                </div>
              )}
              {bankError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {bankError}
                </div>
              )}

              {[
                { key: "bankName",    label: "Nom de la banque",  placeholder: "CIH, Attijariwafa, BMCE..." },
                { key: "rib",         label: "RIB",               placeholder: "XXXXXXXXXXXXXXXXXXXXXXXXXX" },
                { key: "accountName", label: "Titulaire du compte",placeholder: "Prénom Nom" },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">{label}</label>
                  <input
                    type="text"
                    value={bankForm[key]}
                    onChange={(e) => setBankForm((f) => ({ ...f, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    dir="ltr"
                  />
                </div>
              ))}

              <button
                type="submit"
                disabled={bankSaving}
                className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
              >
                {bankSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {bankSaving ? "Enregistrement..." : "Enregistrer"}
              </button>
            </form>
          </Section>
        )}

        {/* ══ PAYOUT ════════════════════════════════════════════════════════ */}
        {activeTab === "payout" && (
          <div className="space-y-4">
            {/* ONE wallet total + its breakdown (earnings vs recharged) */}
            <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-6 text-white">
              <p className="text-sm font-medium opacity-70 mb-1">Solde total disponible</p>
              <p className="text-4xl font-black">{fmtMoney(balance)}</p>
              {(topupAvailable > 0 || pendingPayouts > 0) ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-4">
                  <div className="rounded-xl bg-white/10 px-3 py-2">
                    <p className="text-[11px] opacity-70">Gains disponibles pour retrait</p>
                    <p className="text-base font-black">{fmtMoney(withdrawable)}</p>
                  </div>
                  <div className="rounded-xl bg-white/10 px-3 py-2">
                    <p className="text-[11px] opacity-70">Montant en attente de paiement</p>
                    <p className="text-base font-black">{fmtMoney(pendingPayouts)}</p>
                    <p className="text-[10px] opacity-50 mt-0.5">Déjà réservé</p>
                  </div>
                  <div className="rounded-xl bg-white/10 px-3 py-2">
                    <p className="text-[11px] opacity-70">Solde rechargé non retirable</p>
                    <p className="text-base font-black">{fmtMoney(topupAvailable)}</p>
                    <p className="text-[10px] opacity-50 mt-0.5">Achats uniquement</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs opacity-50 mt-2">Commissions des commandes livrées</p>
              )}
            </div>

            {/* Request form */}
            <Section title="Demande de retrait" icon={CreditCard}>
              <form onSubmit={handlePayout} className="space-y-4 max-w-sm">
                {payoutMsg && (
                  <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium
                    ${payoutMsg.type === "success"
                      ? "bg-green-50 border border-green-100 text-green-700"
                      : "bg-red-50 border border-red-100 text-red-700"}`}>
                    {payoutMsg.type === "success" ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                    {payoutMsg.text}
                  </div>
                )}
                {!identityApproved && (
                  <div className="rounded-xl px-4 py-3 bg-red-50 border border-red-200 text-red-800 text-sm">
                    <p className="flex items-start gap-2">
                      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                      Votre identité doit être vérifiée avant de pouvoir effectuer un retrait.
                    </p>
                    <button type="button" onClick={goToIdentity}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg">
                      <ShieldCheck className="w-3.5 h-3.5" /> Vérifier maintenant
                    </button>
                  </div>
                )}
                {!bankComplete && (
                  <div className="rounded-xl px-4 py-3 bg-amber-50 border border-amber-200 text-amber-800 text-sm">
                    <p className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      Veuillez ajouter vos coordonnées bancaires avant de demander un retrait.
                    </p>
                    <button type="button" onClick={() => setActiveTab("bank")}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg">
                      <Building2 className="w-3.5 h-3.5" /> Compléter mes coordonnées
                    </button>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                    Montant à retirer (MAD)
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
                    Maximum retirable : <strong>{fmtMoney(withdrawable)}</strong>
                  </p>
                  {pendingPayouts > 0 && (
                    <p className="text-[11px] text-gray-500 mt-1">
                      {fmtMoney(pendingPayouts)} déjà réservés par une demande en attente de paiement.
                    </p>
                  )}
                  {topupAvailable > 0 && (
                    <p className="text-[11px] text-amber-600 mt-1">
                      {fmtMoney(topupAvailable)} de solde rechargé ne sont pas retirables (achats de packs et services uniquement).
                    </p>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!identityApproved || !bankComplete || payoutLoading || !payoutAmount || parseFloat(payoutAmount) <= 0 || parseFloat(payoutAmount) > withdrawable}
                  className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-all"
                >
                  {payoutLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                  {payoutLoading ? "Envoi..." : "Demander le retrait"}
                </button>
              </form>
            </Section>

            {/* Balance history — payouts + Starter Booster purchases, one merged
                list (the boosters reuse THIS history; no separate page). */}
            {((stats?.payouts?.length || 0) + boosterPurchases.length) > 0 && (
              <Section title="Historique du solde" icon={TrendingUp}>
                <div className="space-y-2">
                  {[
                    ...(stats?.payouts || []).map((p) => ({ kind: "payout", ...p })),
                    ...boosterPurchases.map((b) => ({ kind: "booster", ...b })),
                  ]
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                    .map((x) => x.kind === "payout" ? (
                      <div key={`p-${x.id}`} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-gray-800">Retrait · {fmtMoney(x.amount)}</p>
                          <p className="text-xs text-gray-400">{fmtDate(x.createdAt)}</p>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold
                          ${x.status === "paid" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                          {x.status === "paid" ? "Payé" : "En attente"}
                        </span>
                      </div>
                    ) : (
                      <div key={`b-${x.id}`} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-gray-800">🚀 {x.packageName} · −{fmtMoney(x.price)}</p>
                          <p className="text-xs text-gray-400">
                            {x.paymentMethod === "BALANCE" ? "Payé avec le solde" : "Payé par carte"} · {fmtDate(x.createdAt)}
                          </p>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold
                          ${x.status === "ACTIVE" ? "bg-green-100 text-green-700" : x.status === "REJECTED" ? "bg-red-100 text-red-600" : "bg-yellow-100 text-yellow-700"}`}>
                          {x.status === "ACTIVE" ? "Actif" : x.status === "REJECTED" ? "Refusé" : "En attente"}
                        </span>
                      </div>
                    ))}
                </div>
              </Section>
            )}

            {/* Store bank info for payouts */}
            {storeBankInfo && (storeBankInfo.bankName || storeBankInfo.rib) && (
              <Section title="Informations bancaires du paiement" icon={Building2}>
                <p className="text-xs text-gray-400 mb-3">
                  Vos commissions seront versées sur le compte suivant. Assurez-vous que vos coordonnées bancaires (onglet Banque) sont à jour.
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
                    { label: "Banque",    value: storeBankInfo.bankName    },
                    { label: "Titulaire", value: storeBankInfo.accountName },
                    { label: "RIB",       value: storeBankInfo.rib,    mono: true },
                    { label: "SWIFT",     value: storeBankInfo.swift,  mono: true },
                  ].map(({ label, value, mono }) =>
                    value ? (
                      <div key={label} className="flex items-center justify-between px-4 py-2.5">
                        <span className="text-xs text-gray-400 font-medium">{label}</span>
                        <span className={`text-sm font-semibold text-gray-800 text-right max-w-[200px] break-all ${mono ? "font-mono text-xs" : ""}`}>
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
          <Section title="Notifications" icon={Bell}>
            {notifs.length === 0 ? (
              <div className="text-center py-10">
                <Bell className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">Aucune notification</p>
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
                      <p className={`text-sm ${n.read ? "text-gray-600" : "text-gray-800 font-medium"}`}>
                        {n.message}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{fmtDate(n.createdAt)}</p>
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
                setClaimMsg({ type: "success", text: `Félicitations ! ${d.bonus} MAD ajoutés à votre solde.` });
                fetchAll(token);
              } else {
                setClaimMsg({ type: "error", text: d.error || ("Erreur") });
              }
            } catch { setClaimMsg({ type: "error", text: "Erreur réseau" }); }
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
                        {"Bonus d'équipe"}
                      </p>
                      <p className={`text-xs font-semibold ${bonusClaimed ? "text-gray-400" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                        {bonusClaimed
                          ? ("Bonus déjà réclamé ✓")
                          : `Gagnez ${bonusAmount} MAD avec ${bonusGoal} filleuls actifs`}
                      </p>
                    </div>
                  </div>
                  <div className={`text-right px-3 py-1.5 rounded-xl ${bonusClaimed ? "bg-gray-200" : bonusUnlocked ? "bg-amber-900/20" : "bg-amber-950/40"}`}>
                    <p className={`text-xl font-black ${bonusClaimed ? "text-gray-500" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>
                      {bonusAmount} <span className="text-sm font-semibold">MAD</span>
                    </p>
                  </div>
                </div>

                {/* Counters */}
                <div className="flex gap-2 mb-3">
                  <div className={`flex-1 rounded-xl p-2.5 text-center ${bonusClaimed ? "bg-gray-200/60" : bonusUnlocked ? "bg-amber-900/15" : "bg-amber-950/40"}`}>
                    <p className={`text-xl font-black ${bonusClaimed ? "text-gray-500" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>{stats?.totalReferrals ?? team.length}</p>
                    <p className={`text-xs ${bonusClaimed ? "text-gray-400" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                      {"Total parrainés"}
                    </p>
                  </div>
                  <div className={`flex-1 rounded-xl p-2.5 text-center ${bonusClaimed ? "bg-green-100" : bonusUnlocked ? "bg-amber-900/15" : "bg-amber-950/40"}`}>
                    <p className={`text-xl font-black ${bonusClaimed ? "text-green-600" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>{validReferrals}</p>
                    <p className={`text-xs ${bonusClaimed ? "text-green-500" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                      {"Actifs"}
                    </p>
                  </div>
                  <div className={`flex-1 rounded-xl p-2.5 text-center ${bonusClaimed ? "bg-gray-200/60" : bonusUnlocked ? "bg-amber-900/15" : "bg-amber-950/40"}`}>
                    <p className={`text-xl font-black ${bonusClaimed ? "text-gray-500" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>{bonusGoal}</p>
                    <p className={`text-xs ${bonusClaimed ? "text-gray-400" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                      {"Objectif"}
                    </p>
                  </div>
                </div>

                {/* Progress bar */}
                <div className={`w-full rounded-full h-3 overflow-hidden mb-3 ${bonusClaimed ? "bg-gray-300" : bonusUnlocked ? "bg-amber-900/20" : "bg-amber-950/50"}`}>
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${bonusClaimed ? "bg-gray-400" : bonusUnlocked ? "bg-amber-900" : "bg-gradient-to-r from-amber-400 to-yellow-300"}`}
                    style={{ width: `${bonusProgress}%` }}
                  />
                </div>
                <div className={`flex justify-between text-xs mb-4 ${bonusClaimed ? "text-gray-400" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                  <span>{validReferrals} / {bonusGoal} {"filleuls actifs"}</span>
                  <span className="font-semibold">{bonusProgress}%</span>
                </div>

                {/* Claim button / status */}
                {bonusClaimed ? (
                  <div className="flex items-center justify-center gap-2 py-2.5 bg-gray-300 rounded-xl text-gray-500 text-sm font-bold">
                    <CheckCircle className="w-4 h-4" />
                    {"Bonus réclamé"}
                  </div>
                ) : bonusUnlocked ? (
                  <button
                    onClick={handleClaimBonus}
                    disabled={claiming}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-amber-900 hover:bg-amber-950 active:scale-[0.98] text-amber-100 rounded-xl text-sm font-black transition-all shadow-lg disabled:opacity-60"
                  >
                    {claiming ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>🎁</span>}
                    {"Réclamer la récompense"}
                  </button>
                ) : (
                  <div className="flex items-center justify-center gap-2 py-2.5 bg-amber-950/40 rounded-xl text-amber-300 text-xs font-semibold">
                    🔒 {`Encore ${Math.max(0, bonusGoal - validReferrals)} filleul(s) actif(s) requis`}
                  </div>
                )}

                {claimMsg && (
                  <div className={`mt-2 text-xs text-center font-semibold rounded-xl py-2 ${claimMsg.type === "success" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {claimMsg.text}
                  </div>
                )}
              </div>
            </div>

            {/* ── Commission tiers legend ── */}
            {bonusConfig.commissionTiers?.length > 0 && (
              <Section title={"Barème de commission dynamique"} icon={TrendingUp}>
                <div className="space-y-2">
                  {bonusConfig.commissionTiers.map((t, i) => (
                    <div key={i} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-xl">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center text-xs font-bold text-blue-600">
                          {i + 1}
                        </div>
                        <span className="text-sm text-gray-700">
                          {t.maxDelivered == null
                            ? (`${t.minDelivered}+ livraisons`)
                            : (`${t.minDelivered}–${t.maxDelivered} livraisons`)}
                        </span>
                      </div>
                      <span className="text-sm font-black text-blue-700 bg-blue-50 px-2.5 py-0.5 rounded-full">
                        {t.commissionPct}%
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  {"La commission augmente automatiquement selon les livraisons du filleul."}
                </p>
              </Section>
            )}

            {/* ── Invite link ── */}
            <Section title={"Inviter un partenaire"} icon={UserPlus}>
              <div className="flex gap-2">
                <div className="flex-1 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs font-mono text-gray-700 truncate">
                  {refLink}
                </div>
                <CopyButton text={refLink} />
              </div>
              <p className="text-xs text-gray-400 mt-2">
                {"Partagez ce lien. Les personnes qui s'inscrivent via ce lien rejoindront votre équipe."}
              </p>
            </Section>

            {/* ── Team list ── */}
            <Section title={`${"Mon équipe"} (${team.length})`} icon={Users}>
              {team.length === 0 ? (
                <div className="text-center py-10">
                  <Users className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                  <p className="text-gray-400 text-sm">
                    {"Votre équipe est vide pour l'instant"}
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
                            className={`w-full text-left flex items-center justify-between px-3.5 py-2.5 transition-colors cursor-pointer hover:brightness-95
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
                                  <span className="absolute -top-1 -right-1 text-[9px] leading-none">🥇</span>
                                )}
                                {rank === 1 && score > 0 && (
                                  <span className="absolute -top-1 -right-1 text-[9px] leading-none">🥈</span>
                                )}
                                {rank === 2 && score > 0 && (
                                  <span className="absolute -top-1 -right-1 text-[9px] leading-none">🥉</span>
                                )}
                              </div>

                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="text-sm font-bold text-gray-800 truncate">{m.name || m.username}</p>
                                  {isFireActive && (
                                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-green-200 text-green-800 whitespace-nowrap">
                                      Actif 🔥
                                    </span>
                                  )}
                                  {isPotential && (
                                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 whitespace-nowrap">
                                      Potentiel 🔥
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-gray-400 font-mono">@{m.username}</p>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0 ml-2">
                              {/* Score badge */}
                              {score > 0 && (
                                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 whitespace-nowrap">
                                  {"Score"} {score}
                                </span>
                              )}

                              {/* Status badge */}
                              <span className={`text-xs px-2.5 py-1 rounded-full font-bold whitespace-nowrap
                                ${isActive ? "bg-green-200 text-green-800" : "bg-amber-100 text-amber-700"}`}>
                                {isActive
                                  ? ("Actif")
                                  : ("En attente")}
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
                              <p className="text-xs text-gray-400">{"Livrées"}</p>
                            </div>
                            <div className="text-center py-2.5 px-1.5">
                              <p className="text-base font-black text-blue-700">{commPct}%</p>
                              <p className="text-xs text-gray-400">{"Commission"}</p>
                            </div>
                            <div className="text-center py-2.5 px-1.5">
                              <p className="text-base font-black text-amber-700">
                                {revenue.toFixed(0)} <span className="text-[10px] font-semibold">MAD</span>
                              </p>
                              <p className="text-xs text-gray-400">{"CA généré"}</p>
                            </div>
                            <div className="text-center py-2.5 px-1.5">
                              <p className="text-[11px] font-black leading-tight">
                                <span className="text-green-600">{sub.active}</span>
                                <span className="text-gray-300 mx-0.5">/</span>
                                <span className="text-amber-500">{sub.pending}</span>
                              </p>
                              <p className="text-xs text-gray-400">{"Filleuls"}</p>
                            </div>
                          </div>

                          {/* ── Earnings row ── */}
                          {isActive && (
                            <div className="flex items-center justify-between px-3.5 py-2 bg-blue-50 border-t border-blue-100">
                              <span className="text-xs text-blue-700">
                                {"Vos gains de ce filleul"}
                              </span>
                              <span className="text-sm font-black text-blue-800">+{parentEarn.toFixed(0)} MAD</span>
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
                                    {"Commandes"}
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
                                      {"Équipe"}
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
                                        {"Commandes"}
                                      </span>
                                    </div>

                                    {isLoadingOrders ? (
                                      <div className="flex items-center justify-center gap-2 py-6 bg-white mx-3 mb-3 rounded-xl border border-gray-100">
                                        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                        <span className="text-xs text-gray-400">
                                          {"Chargement..."}
                                        </span>
                                      </div>
                                    ) : !memberOrders || memberOrders.length === 0 ? (
                                      <div className="flex flex-col items-center py-8 bg-white mx-3 mb-3 rounded-xl border border-dashed border-gray-200">
                                        <Package className="w-8 h-8 text-gray-200 mb-2" />
                                        <p className="text-xs font-semibold text-gray-400">
                                          {"Aucune commande pour l'instant"}
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
                                                {"Commandes"}
                                              </p>
                                            </div>
                                            <div className="text-center py-2.5 px-2">
                                              <p className="text-sm font-black text-amber-700">
                                                {totalRevenue.toFixed(0)}
                                                <span className="text-[9px] font-semibold ml-0.5">MAD</span>
                                              </p>
                                              <p className="text-[10px] text-gray-400">
                                                {"CA total"}
                                              </p>
                                            </div>
                                            <div className="text-center py-2.5 px-2">
                                              <p className="text-sm font-black text-green-700">
                                                +{totalEarnings.toFixed(0)}
                                                <span className="text-[9px] font-semibold ml-0.5">MAD</span>
                                              </p>
                                              <p className="text-[10px] text-gray-400">
                                                {"Vos gains"}
                                              </p>
                                            </div>
                                          </div>

                                          {/* ── Order mini-cards ── */}
                                          <div className="px-3 pb-3 space-y-2 max-h-80 overflow-y-auto">
                                            {memberOrders.map((o) => {
                                              const sCfg    = STATUS_CONFIG[o.status] || { label: o.status, cls: "bg-gray-100 text-gray-600" };
                                              const shortId = o.orderId || o.id.slice(0, 8).toUpperCase();
                                              const dateStr = new Date(o.createdAt).toLocaleDateString(
                                                "fr-FR",
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
                                                      {o.productTitle || ("Produit")}
                                                    </p>
                                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${sCfg.cls}`}>
                                                      {sCfg.label}
                                                    </span>
                                                  </div>

                                                  {/* Line 2: meta (ID · date · client) */}
                                                  <p className="text-[10px] text-gray-400 font-mono mb-2.5 truncate">
                                                    #{shortId}
                                                    <span className="mx-1 text-gray-300">·</span>
                                                    {dateStr}
                                                    {o.clientName && (
                                                      <>
                                                        <span className="mx-1 text-gray-300">·</span>
                                                        {o.clientName}
                                                      </>
                                                    )}
                                                  </p>

                                                  {/* Line 3: total (left) + commission (right) */}
                                                  <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                                                    <div className="flex items-center gap-1">
                                                      <span className="text-[10px] text-gray-400">
                                                        {"Total"}
                                                      </span>
                                                      <span className="text-xs font-black text-gray-700">
                                                        {o.total.toFixed(0)} MAD
                                                      </span>
                                                    </div>
                                                    <span className={`text-xs font-black
                                                      ${isDelivered ? "text-green-700" : "text-gray-500"}`}>
                                                      {isDelivered ? "+" : ""}{o.commissionAmount.toFixed(0)} MAD
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
                                          {"Chargement..."}
                                        </span>
                                      </div>
                                    ) : !subMembers || subMembers.length === 0 ? (
                                      <div className="flex flex-col items-center py-6">
                                        <Users className="w-7 h-7 text-gray-200 mb-2" />
                                        <p className="text-xs text-gray-400">
                                          {"Aucun filleul enregistré"}
                                        </p>
                                      </div>
                                    ) : (
                                      <div className="px-3.5 py-2.5 space-y-1.5">
                                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                                          {`Équipe de @${m.username}`}
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
                                                <span className="font-semibold text-gray-700 truncate">@{s.username}</span>
                                                {s.deliveredOrdersCount > 0 && (
                                                  <span className="text-gray-400 shrink-0">
                                                    · {s.deliveredOrdersCount} {"liv."}
                                                  </span>
                                                )}
                                              </div>
                                              <span className={`px-2 py-0.5 rounded-full font-bold shrink-0 ml-2
                                                ${sActive ? "bg-green-200 text-green-800" : "bg-amber-100 text-amber-700"}`}>
                                                {sActive
                                                  ? ("Actif")
                                                  : ("En attente")}
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
                {"Triés par performance. Cliquez sur un membre pour voir ses commandes et son équipe."}
              </p>
            </Section>
          </div>
          );
        })()}

        {/* ══ COMPETITION ═══════════════════════════════════════════════════ */}
        {activeTab === "deposit" && (
          <DepositTab token={token} onChanged={() => fetchAll(token, { silent: true })} />
        )}

        {activeTab === "booster" && <BoosterTab onRecharge={goToDeposit} />}

        {activeTab === "rewards" && <RewardsTab />}

        {activeTab === "ugc" && <UgcTab />}

        {/* Competition now lives inline on the overview (no standalone tab). */}

        {/* ══ SETTINGS ══════════════════════════════════════════════════════ */}
        {activeTab === "settings" && (
          <div className="space-y-5 max-w-md">

            {/* ── Profile Picture ── */}
            <Section title="Photo de profil" icon={Users}>
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
            <Section title="Modifier le profil" icon={Star}>
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
                  if (!res.ok) { alert(json.error || "Erreur"); return; }
                  setData(d => ({ ...d, affiliate: json.affiliate }));
                  alert("Profil mis à jour ✓");
                } catch { alert("Erreur réseau"); }
              }} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Nom complet</label>
                  <input name="name" defaultValue={affiliate?.name || ""}
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    placeholder="Votre nom" required />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Nom d'utilisateur</label>
                  <input value={affiliate?.username ?? ""} disabled
                    className="w-full px-4 py-2.5 text-sm border border-gray-100 rounded-xl bg-gray-100 text-gray-400 cursor-not-allowed" />
                  <p className="text-xs text-gray-400 mt-1">Le nom d'utilisateur ne peut pas être modifié.</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Numéro de téléphone</label>
                  {affiliate?.phone ? (
                    <>
                      <input value={affiliate.phone ?? ""} disabled
                        className="w-full px-4 py-2.5 text-sm border border-gray-100 rounded-xl bg-gray-100 text-gray-400 cursor-not-allowed font-mono" />
                      <p className="text-xs text-gray-400 mt-1">Le numéro de téléphone ne peut pas être modifié.</p>
                    </>
                  ) : (
                    <>
                      <input name="phone" type="tel"
                        className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 font-mono"
                        placeholder="0612345678" dir="ltr" />
                      <p className="text-xs text-amber-500 mt-1">⚠ Une fois enregistré, le numéro ne pourra plus être modifié.</p>
                    </>
                  )}
                </div>
                <button type="submit"
                  className="w-full py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-xl hover:bg-gray-700 transition-colors">
                  Enregistrer le profil
                </button>
              </form>
            </Section>

            {/* ── Change Password ── */}
            <Section title="Changer le mot de passe" icon={AlertCircle}>
              <form onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.target);
                const currentPassword = fd.get("currentPassword");
                const newPassword     = fd.get("newPassword");
                const confirmPassword = fd.get("confirmPassword");
                if (newPassword !== confirmPassword) { alert("Les mots de passe ne correspondent pas"); return; }
                if (newPassword.length < 6) { alert("Le mot de passe doit contenir au moins 6 caractères"); return; }
                try {
                  const res = await fetch("/api/affiliate/me", {
                    method: "PUT",
                    headers: authHeaders(),
                    body: JSON.stringify({ type: "profile", currentPassword, newPassword }),
                  });
                  const json = await res.json();
                  if (!res.ok) { alert(json.error || "Erreur"); return; }
                  e.target.reset();
                  alert("Mot de passe changé ✓");
                } catch { alert("Erreur réseau"); }
              }} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Mot de passe actuel</label>
                  <input name="currentPassword" type="password" required
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    placeholder="••••••••" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Nouveau mot de passe</label>
                  <input name="newPassword" type="password" required minLength={6}
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    placeholder="••••••••" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Confirmer le mot de passe</label>
                  <input name="confirmPassword" type="password" required minLength={6}
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    placeholder="••••••••" />
                </div>
                <button type="submit"
                  className="w-full py-2.5 bg-red-600 text-white text-sm font-semibold rounded-xl hover:bg-red-700 transition-colors">
                  Changer le mot de passe
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
          <button type="button" onClick={() => setOrderNotice(null)} className="text-white/60 hover:text-white" aria-label="×"><X className="w-4 h-4" /></button>
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
      />

    </div>
  );
}
