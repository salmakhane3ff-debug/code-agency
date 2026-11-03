"use client";

/**
 * 🏪 Create Your Own Brand — paid TRAINING SIMULATOR (affiliate side).
 *
 *   no access   → landing: title, hero built from the packages' real catalogue
 *                 product images, the services the admin listed as included,
 *                 what is bought (training + simulated data, no real sales, no
 *                 earnings), and the package cards — price, product count,
 *                 included services and the full price breakdown up front.
 *                 Then the guided creation: (2) exactly that package's number of
 *                 products from its list, (3) fictional brand name + optional
 *                 branding option, (4) review — itemised costs, VAT, total,
 *                 PUBLISHED refund terms — "Buy Now"
 *   pending     → brand header (pending), products, saved breakdown, bank
 *                 details and the transfer-proof upload (reused deposit
 *                 components; stored as a BRAND proof, never as a deposit);
 *                 access is activated only when an admin accepts the proof
 *   active      → _brand/BrandDashboard: hero + brand, SIMULATED analytics
 *                 (24 h / 7 d / 30 d counts + chart), latest simulated orders
 *                 (tap → details), selected products and the pack price (what
 *                 the training costs — never earnings); no amount per order
 *   closed      → the same dashboard, READ-ONLY as of the closure, with its reason
 *   consent     → when the terms accepted with a request cannot be verified: a
 *                 pending request shows that payment is unavailable (a fresh
 *                 consent may be recorded but never makes it payable); a closed
 *                 request offers a fresh consent to the current terms
 *
 * Every package, price, cost, percentage, option, term and statistic comes from
 * the APIs; this UI never decides eligibility, never sends an amount and never
 * sends an affiliate id. The affiliate's real earnings and statistics stay in
 * their own dashboard tabs; nothing here reads or shows them. Language follows
 * the site (FR/AR) like the Rewards tab, with a local `dir`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2, Store, CheckCircle, Clock, Info, XCircle, GraduationCap, Package, ChevronDown,
  ArrowLeft, ArrowRight, Crown, Check, Boxes,
} from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { brandT, brandDir } from "@/lib/brandI18n";
import { BRAND_LIMITS } from "@/lib/brandProgram";
import { displayBreakdown } from "@/lib/brandPricing";
import BrandDashboard from "./_brand/BrandDashboard";
import BankDetailsCard from "@/components/checkout/BankDetailsCard";
import ProofUploadCard from "@/components/checkout/ProofUploadCard";

const DASHBOARD_POLL_MS = 60_000;
const DAY_MS = 86_400_000;
const CARD = "bg-white rounded-2xl border border-gray-100 shadow-sm";
const BTN_PRIMARY = "inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-2xl text-sm font-black bg-violet-600 text-white shadow-md shadow-violet-200 hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 disabled:opacity-40 disabled:shadow-none";
const BTN_GHOST = "inline-flex items-center justify-center gap-1.5 px-4 py-3 rounded-2xl text-sm font-semibold bg-white border border-gray-200 text-gray-700 hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400";

function authHeaders(json = false) {
  const t = (typeof localStorage !== "undefined" && localStorage.getItem("affiliateToken")) || "";
  return { Authorization: `Bearer ${t}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function call(url, { method = "GET", body } = {}) {
  try {
    const res = await fetch(url, {
      method, cache: "no-store", headers: authHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function newRequestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const PROOF_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const PROOF_MAX_BYTES = 8 * 1024 * 1024; // same limit as the server (DEPOSIT_MAX_BYTES), checked again there

const errorText = (r, t) => (r.status === 0 ? t("error_network") : (r.data?.code ? t(`code_${r.data.code}`, { n: r.data.expected ?? "" }) : t("error_generic")));

/**
 * Square product thumbnail. Plain <img>: catalogue images come from the store's
 * own media hosts (sanitised server-side to http(s) or site paths), which are not
 * all configured for next/image.
 */
function Thumb({ src, iconCls, rounded = "" }) {
  // A missing or failing image shows the package icon (never a broken image).
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <div className={`aspect-square bg-gray-50 flex items-center justify-center overflow-hidden ${rounded}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="w-full h-full object-cover" /> : <Package className={`${iconCls} text-gray-300`} aria-hidden="true" />}
    </div>
  );
}

/** Small read-only list of products (thumbnail + name), used on review, pending and active views. */
function ProductList({ products }) {
  if (!products?.length) return null;
  return (
    <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {products.map((p) => (
        <li key={p.id} className="rounded-xl border border-gray-100 bg-white overflow-hidden">
          <Thumb src={p.image} iconCls="w-6 h-6" />
          <p dir="auto" className="px-2 py-1.5 text-[11px] font-semibold text-gray-800 line-clamp-2">{p.title}</p>
        </li>
      ))}
    </ul>
  );
}

/** Purple numbered step title (reference: "1 اختر نوع المنتجات"). */
function NumTitle({ n, children }) {
  return (
    <h3 className="flex items-center gap-2.5 text-base font-black text-gray-900">
      <span className="w-8 h-8 rounded-full bg-violet-600 text-white text-sm font-black flex items-center justify-center shrink-0">{n}</span>{children}
    </h3>
  );
}

/**
 * Price breakdown of a package, as computed by the server (lib/brandPricing.js):
 * price + delivery + logistics = subtotal; VAT on the subtotal; total to pay.
 * Informational percentages are listed apart, each with its calculation base,
 * and are never added to the total. A saved snapshot may lack fields (see
 * displayBreakdown): a missing figure shows "—", a missing section is omitted.
 */
function Breakdown({ b: raw, t, money: fmt }) {
  const b = displayBreakdown(raw);
  if (!b) return null;
  const money = (n) => (n === null ? "—" : fmt(n));
  const row = (label, value, strong = false) => (
    <p className={`flex justify-between gap-3 ${strong ? "font-black text-gray-900" : "text-gray-700"}`}>
      <span className={strong ? "" : "text-gray-500"}>{label}</span><span className={`whitespace-nowrap ${strong ? "text-violet-700" : "font-semibold"}`}>{value}</span>
    </p>
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 space-y-1" data-breakdown>
        <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wide mb-1">{t("bd_title")}</p>
        {row(t("bd_price"), money(b.price))}
        {row(t("bd_delivery"), money(b.deliveryCost))}
        {row(t("bd_logistics"), money(b.logisticsCost))}
        <div className="border-t border-gray-200 my-1" />
        {row(t("bd_subtotal"), money(b.subtotal))}
        {row(t("bd_vat", { p: b.vat.percent ?? "—" }), money(b.vat.amount))}
        <div className="border-t border-gray-200 my-1" />
        {row(t("bd_total"), money(b.total), true)}
      </div>
      {b.informational.length > 0 && <div className="rounded-xl border border-dashed border-gray-200 p-3 space-y-1">
        <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wide mb-1">{t("bd_info_title")}</p>
        {b.informational.map((x) => (
          <p key={x.key} className="flex justify-between gap-3 text-gray-600">
            <span>{t(`pct_${x.key}`)} · {x.percent} % {t(`base_${x.base}`)}{x.baseAmount !== null ? ` (${money(x.baseAmount)})` : ""}</span>
            <span className="font-semibold shrink-0 whitespace-nowrap">{x.amount !== null ? money(x.amount) : `${x.percent} %`}</span>
          </p>
        ))}
        <p className="text-[11px] text-gray-500 pt-1">{t("bd_info_note")}</p>
      </div>}
    </div>
  );
}

/** What is (and is not) bought — always shown above the offer. */
function WhatYouBuy({ t }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 sm:p-5">
      <h3 className="text-sm font-black text-amber-900 mb-2 flex items-center gap-1.5"><Info className="w-4 h-4" aria-hidden="true" />{t("what_title")}</h3>
      <ul className="space-y-1.5 text-sm text-amber-900">
        {["what_access", "what_simulated", "what_no_earnings"].map((k) => <li key={k} className="leading-relaxed">• {t(k)}</li>)}
      </ul>
    </div>
  );
}

/** A pack image (first catalogue image of the pack); a missing or failing image shows the package icon. */
function PackImage({ src, className = "" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <div className={`flex items-center justify-center overflow-hidden ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="max-w-full max-h-full object-contain" />
        : <Package className="w-10 h-10 text-violet-300" aria-hidden="true" />}
    </div>
  );
}

/** Landing hero: purple gradient, title, training badge and real catalogue images of the offered packs (nothing invented). */
function Landing({ t, packages }) {
  const images = [];
  for (const p of packages) for (const pr of p.products || []) if (pr.image && !images.includes(pr.image) && images.length < 3) images.push(pr.image);
  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-violet-700 via-violet-600 to-fuchsia-500 text-white p-5 sm:p-6 shadow-lg shadow-violet-200" data-hero>
      <div aria-hidden="true" className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
      <div aria-hidden="true" className="absolute -bottom-12 end-24 w-28 h-28 rounded-full bg-fuchsia-300/20" />
      <div className="relative flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-white/15 text-white text-[11px] font-bold"><GraduationCap className="w-3 h-3" aria-hidden="true" />{t("training_badge")}</span>
          <h2 className="text-2xl sm:text-3xl font-black leading-tight mt-2">{t("title")}</h2>
          <p className="text-lg sm:text-xl font-black text-violet-100 leading-tight" dir="ltr">{t("title_en")}</p>
          <p className="text-[13px] sm:text-sm text-violet-50/90 mt-2 leading-snug">{t("landing_intro")}</p>
        </div>
        <div className="relative w-24 sm:w-36 h-28 sm:h-36 shrink-0" aria-hidden="true">
          {images.length ? images.map((src, i) => (
            <div key={src} className="absolute w-16 sm:w-24 rounded-2xl overflow-hidden shadow-lg ring-2 ring-white bg-white"
              style={{ insetInlineEnd: `${i * 14}px`, top: `${i * 16}px`, zIndex: 3 - i, transform: `rotate(${(i - 1) * 6}deg)` }}>
              <Thumb src={src} iconCls="w-6 h-6" />
            </div>
          )) : <div className="absolute inset-0 flex items-center justify-center"><Store className="w-14 h-14 text-white/80" /></div>}
        </div>
      </div>
    </section>
  );
}

/**
 * One pack in the comparison: image, name, product count, physical pieces (when
 * configured), price, availability, main features. Its full details open in a
 * sheet (PackDetailsSheet), so a card never changes size and never affects the
 * others. Every value is the admin's configuration of THIS pack.
 */
function PackCard({ p, on, single, onSelect, onDetails, t, money }) {
  const img = (p.products || []).find((x) => x.image)?.image || null;
  return (
    <div data-package-id={p.id} data-selected={on ? "true" : "false"}
      className={`relative snap-start shrink-0 flex flex-col rounded-3xl border-2 bg-white p-3.5 transition-colors ${single ? "w-full" : "w-[80%] max-w-[300px] sm:w-auto sm:max-w-none"} ${on ? "border-violet-600 shadow-lg shadow-violet-100" : "border-gray-100 shadow-sm"}`}>
      {on && <span className="absolute -top-3 end-3 w-8 h-8 rounded-full bg-violet-600 text-white flex items-center justify-center ring-4 ring-white" aria-hidden="true" data-check><Check className="w-4 h-4" /></span>}
      <button type="button" role="radio" aria-checked={on} onClick={() => onSelect(p.id)}
        className="text-center rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
        <PackImage src={img} className="h-28 sm:h-32 rounded-2xl bg-gradient-to-b from-violet-50 to-white p-2" />
        <p dir="auto" className="text-lg font-black text-gray-900 mt-2 leading-tight">{p.name}</p>
        <p className="text-xs font-bold text-amber-700 mt-1">{t("package_products", { n: p.productCount })}</p>
        {p.quantity ? <p className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 mt-0.5" data-pack-quantity><Boxes className="w-3.5 h-3.5" aria-hidden="true" />{t("pack_pieces", { n: p.quantity })}</p> : null}
        <p className="mt-2 rounded-2xl bg-violet-50 py-1.5 text-2xl font-black text-violet-700" dir="ltr" data-pack-price>{money(p.price)}</p>
        <p className="text-[11px] text-gray-500 mt-1">{t("total_payable_short")} : <span className="font-bold text-violet-700">{money(p.breakdown.total)}</span></p>
        <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />{t("pack_available")}
        </span>
      </button>
      {p.description && <p dir="auto" className="text-xs text-gray-600 mt-2 line-clamp-2">{p.description}</p>}
      {p.features?.length > 0 && (
        <ul className="space-y-1.5 mt-2 rounded-2xl bg-gray-50/80 p-2.5" aria-label={t("features_title")}>
          {p.features.slice(0, 3).map((f) => (
            <li key={f} dir="auto" className="flex items-start gap-2 text-xs text-gray-700">
              <span className="w-4 h-4 mt-px rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0" aria-hidden="true"><Check className="w-2.5 h-2.5" /></span>{f}
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => onDetails(p.id)} aria-haspopup="dialog" data-pack-details-toggle
        className="w-full inline-flex items-center justify-center gap-1 text-xs font-semibold text-violet-700 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 rounded-lg">
        {t("package_details_show")}<ChevronDown className="w-4 h-4" aria-hidden="true" />
      </button>
      <button type="button" onClick={() => onSelect(p.id)} aria-pressed={on} data-pack-select
        className={`mt-1 w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-2xl text-sm font-black focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${on ? "bg-violet-600 text-white" : "border-2 border-violet-600 text-violet-700 bg-white"}`}>
        {on ? <><Check className="w-4 h-4" aria-hidden="true" />{t("pack_selected")}</> : t("pack_select")}
      </button>
    </div>
  );
}

/** Full details of one pack (breakdown, pieces, simulated selling price, included products, all features) in a sheet; select from here too. */
function PackDetailsSheet({ p, on, onSelect, onClose, t, money }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-gray-900/40" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="brand-pack-title" onClick={(e) => e.stopPropagation()} data-pack-details={p.id}
        className="w-full sm:max-w-lg max-h-[88vh] bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <h4 id="brand-pack-title" dir="auto" className="text-base font-black text-gray-900 truncate">{p.name}</h4>
            <p className="text-xs font-bold text-violet-700" dir="ltr">{money(p.price)}</p>
          </div>
          <button type="button" onClick={onClose} autoFocus aria-label={t("pack_details_close")} data-pack-details-close
            className="w-9 h-9 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"><XCircle className="w-5 h-5" aria-hidden="true" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4 space-y-3">
          {p.description && <p dir="auto" className="text-sm text-gray-600 whitespace-pre-line">{p.description}</p>}
          <Breakdown b={p.breakdown} t={t} money={money} />
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs rounded-2xl border border-gray-100 p-2.5">
            <dt className="text-gray-500">{t("pack_pieces_label")}</dt><dd className="font-bold text-gray-900 text-end">{p.quantity ?? "—"}</dd>
            <dt className="text-gray-500">{t("pack_sim_price")}</dt><dd className="font-bold text-gray-900 text-end" dir="ltr">{p.simulatedSellingPrice ? money(p.simulatedSellingPrice) : "—"}</dd>
          </dl>
          {p.products?.length > 0 && (
            <div><p className="text-xs font-black text-gray-900 mb-1.5">{t("pack_included_products")}</p><ProductList products={p.products} /></div>
          )}
          {p.features?.length > 0 && (
            <ul className="space-y-1" aria-label={t("features_title")}>{p.features.map((f) => <li key={f} dir="auto" className="text-xs text-gray-700">• {f}</li>)}</ul>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <button type="button" onClick={() => { onSelect(p.id); onClose(); }} data-pack-details-select
            className={`w-full inline-flex items-center justify-center gap-1.5 py-3 rounded-2xl text-sm font-black focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${on ? "bg-violet-600 text-white" : "border-2 border-violet-600 text-violet-700 bg-white"}`}>
            {on ? <><Check className="w-4 h-4" aria-hidden="true" />{t("pack_selected")}</> : t("pack_select")}
          </button>
        </div>
      </div>
    </div>
  );
}

const STEPS = ["step_package", "step_products", "step_brand", "step_review"];

function Progress({ step, t }) {
  return (
    <div aria-label={t("step_label", { n: step + 1, total: STEPS.length })}>
      <div className="flex gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1}>
        {STEPS.map((k, i) => <span key={k} title={t(k)} className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-violet-600" : "bg-gray-200"}`} />)}
      </div>
      <p className="text-[11px] font-bold text-gray-400 mt-1.5">{t("step_label", { n: step + 1, total: STEPS.length })} · {t(STEPS[step])}</p>
    </div>
  );
}

/**
 * The request: (1) choose a package — every package shows its price breakdown
 * up front, (2) pick exactly its number of products from its own list,
 * (3) name the brand (+ optional branding option), (4) review — package,
 * products, name, itemised costs, VAT, total, refund terms — and "Buy Now".
 * The server re-checks everything and computes the amount itself.
 */
function Offer({ data, t, money, dir, onRequested, onStale }) {
  const packages = data.packages || [];
  const [step, setStep] = useState(0);
  // Nothing is pre-selected: the affiliate compares the packs and picks one.
  const [packageId, setPackageId] = useState(null);
  const [openDetails, setOpenDetails] = useState(null);
  const [selected, setSelected] = useState([]);
  const [brandName, setBrandName] = useState("");
  const [brandingOptionId, setBrandingOptionId] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const requestId = useRef(null);

  const pkg = packages.find((p) => p.id === packageId) || null;
  const pkgProducts = pkg?.products || [];
  const need = pkg?.productCount || 0;
  const Back = dir === "rtl" ? ArrowRight : ArrowLeft;
  const Fwd = dir === "rtl" ? ArrowLeft : ArrowRight;

  // After a reload (PRODUCT_NOT_AVAILABLE / PACKAGE_NOT_FOUND / TERMS_CHANGED): drop a vanished package or product.
  useEffect(() => {
    if (packageId && !packages.some((p) => p.id === packageId)) { setPackageId(null); setSelected([]); setStep(0); return; }
    const ids = new Set(pkgProducts.map((p) => p.id));
    setSelected((cur) => cur.filter((id) => ids.has(id)));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // New published terms must be accepted again.
  useEffect(() => { setAccepted(false); }, [data.terms?.version]);
  // Each step starts at the top of the tab (phones).
  useEffect(() => { if (step > 0 && typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" }); }, [step]);

  const pickPackage = (id) => { if (id !== packageId) { setPackageId(id); setSelected([]); } };
  const detailsPack = packages.find((p) => p.id === openDetails) || null;
  const chosen = selected.map((id) => pkgProducts.find((p) => p.id === id)).filter(Boolean);
  const option = data.brandingOptions?.find((o) => o.id === brandingOptionId) || null;
  const terms = data.terms;
  const cleanName = brandName.replace(/\s+/g, " ").trim();
  const countOk = !!pkg && chosen.length === need;
  const nameOk = cleanName.length >= BRAND_LIMITS.BRAND_NAME_MIN && cleanName.length <= BRAND_LIMITS.BRAND_NAME_MAX;
  const canBuy = countOk && nameOk && !!terms && accepted && !sending;

  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= need ? cur : [...cur, id]));

  const buy = async () => {
    if (!canBuy) return;
    setSending(true);
    setError(null);
    requestId.current = requestId.current || newRequestId(); // a retried click reuses the same key
    const r = await call("/api/affiliate/brand/access", {
      method: "POST",
      body: {
        packageId: pkg.id, productIds: chosen.map((p) => p.id), brandName: cleanName, brandingOptionId: option?.id || null,
        termsVersion: terms.version, acceptTerms: true, clientRequestId: requestId.current,
      },
    });
    setSending(false);
    if (r.ok) { requestId.current = null; onRequested(); return; }
    if (r.status !== 0) requestId.current = null;
    setError(errorText(r, t));
    if (["PRODUCT_NOT_AVAILABLE", "PACKAGE_NOT_FOUND", "TERMS_CHANGED"].includes(r.data?.code)) {
      onStale();
      if (r.data.code === "PRODUCT_NOT_AVAILABLE") setStep(1);
      if (r.data.code === "PACKAGE_NOT_FOUND") setStep(0);
    }
  };

  const nav = (canNext) => (
    <div className="flex gap-2 pt-1">
      <button type="button" onClick={() => { setError(null); setStep(step - 1); }} className={BTN_GHOST}><Back className="w-4 h-4" aria-hidden="true" />{t("back")}</button>
      <button type="button" onClick={() => setStep(step + 1)} disabled={!canNext} className={`flex-1 ${BTN_PRIMARY}`}>{t("next")}<Fwd className="w-4 h-4" aria-hidden="true" /></button>
    </div>
  );

  // ── Screen A: landing + package selection ──────────────────────────────────
  if (step === 0) {
    return (
      <div className="space-y-5">
        <Landing t={t} packages={packages} />
        <WhatYouBuy t={t} />

        <section className="space-y-3" data-packs>
          <div>
            <h3 className="text-xl font-black text-violet-950">{t("package_title")}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{t("pack_compare_sub")}</p>
          </div>
          {packages.length ? (
            <>
              <div role="radiogroup" aria-label={t("package_title")}
                className={packages.length === 1 ? "pt-3" : "-mx-4 px-4 pt-3 pb-2 flex items-start gap-3 overflow-x-auto snap-x snap-mandatory sm:mx-0 sm:px-0 sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:items-start sm:overflow-visible"}>
                {packages.map((p) => (
                  <PackCard key={p.id} p={p} on={p.id === packageId} single={packages.length === 1}
                    onSelect={pickPackage} onDetails={setOpenDetails} t={t} money={money} />
                ))}
              </div>
              {detailsPack && <PackDetailsSheet p={detailsPack} on={detailsPack.id === packageId} onSelect={pickPackage} onClose={() => setOpenDetails(null)} t={t} money={money} />}
              <button type="button" onClick={() => { setError(null); setStep(1); }} disabled={!pkg} data-start
                className={`w-full ${BTN_PRIMARY} py-4 text-base`}>
                {pkg ? t("start_with_pack") : t("select_pack_first")}<Fwd className="w-5 h-5" aria-hidden="true" />
              </button>
            </>
          ) : <p className={`${CARD} text-sm text-gray-500 p-6 text-center`} data-no-packs>{t("no_packages")}</p>}
        </section>

        <div className={`${CARD} p-4 sm:p-5`}>
          <h3 className="text-sm font-black text-gray-900 mb-3">{t("how_title")}</h3>
          <ol className="space-y-2">
            {["how_choose", "how_terms", "how_payment", "how_delay"].map((k, i) => (
              <li key={k} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-700 text-[11px] font-black flex items-center justify-center shrink-0">{i + 1}</span>{t(k)}
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  // ── Screen B: guided creation ──────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => { setError(null); setStep(step - 1); }} aria-label={t("back")}
          className="w-10 h-10 rounded-full flex items-center justify-center text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"><Back className="w-5 h-5" /></button>
        <h2 className="flex-1 text-center text-lg font-black text-gray-900 pe-10">{t("create_title")}</h2>
      </div>
      <Progress step={step} t={t} />

      {pkg && (
        <button type="button" onClick={() => setStep(0)} className={`${CARD} w-full flex items-center justify-between gap-3 px-4 py-3 text-start`}>
          <span className="min-w-0"><span className="block text-[11px] text-gray-500">{t("review_package")}</span><span dir="auto" className="block text-sm font-black text-gray-900 truncate">{pkg.name}</span></span>
          <span className="text-end shrink-0"><span className="block text-[11px] text-gray-500">{t("total_payable_short")}</span><span className="block text-sm font-black text-violet-700">{money(pkg.breakdown.total)}</span></span>
        </button>
      )}

      <div className={`${CARD} p-4 sm:p-5 space-y-4`}>
        {step === 1 && pkg && (
          <>
            <NumTitle n={2}>{t("products_title")}</NumTitle>
            <p className="text-sm text-gray-500 -mt-2">{t("products_hint", { n: need })}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {pkgProducts.map((p) => {
                const on = selected.includes(p.id);
                const blocked = !on && selected.length >= need;
                return (
                  <button key={p.id} type="button" onClick={() => toggle(p.id)} disabled={blocked} aria-pressed={on} data-product-id={p.id}
                    className={`relative text-start rounded-2xl border-2 overflow-hidden bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${on ? "border-violet-500 shadow-md shadow-violet-100" : "border-gray-100 hover:border-gray-300"} ${blocked ? "opacity-40" : ""}`}>
                    <Thumb src={p.image} iconCls="w-8 h-8" />
                    <p dir="auto" className={`px-2.5 py-2 text-xs font-bold line-clamp-2 ${on ? "text-violet-700" : "text-gray-800"}`}>{p.title}</p>
                    <span className={`absolute top-2 end-2 w-6 h-6 rounded-full flex items-center justify-center ${on ? "bg-violet-600 text-white" : "bg-white/90 border border-gray-200 text-transparent"}`} aria-hidden="true"><Check className="w-3.5 h-3.5" /></span>
                  </button>
                );
              })}
            </div>
            <p className={`text-xs font-semibold ${countOk ? "text-emerald-700" : "text-gray-500"}`} aria-live="polite">{t("products_count", { n: selected.length, max: need })}</p>
            {selected.length >= need && <p className="text-xs text-gray-500">{t("products_max_reached")}</p>}
            <p className="text-[11px] text-gray-500 bg-gray-50 rounded-xl px-3 py-2">{t("products_training_note")}</p>
            {nav(countOk)}
          </>
        )}

        {step === 2 && (
          <>
            <NumTitle n={3}>{t("brand_name")}</NumTitle>
            <label className="block">
              <span className="sr-only">{t("brand_name")}</span>
              <span className="relative block">
                <Crown className="absolute top-1/2 -translate-y-1/2 start-3 w-5 h-5 text-gray-700" aria-hidden="true" />
                <input dir="auto" value={brandName} maxLength={BRAND_LIMITS.BRAND_NAME_MAX} onChange={(e) => setBrandName(e.target.value)} name="brandName"
                  className="w-full text-base border border-gray-200 rounded-2xl ps-11 pe-3 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-violet-400" />
              </span>
              <span className={`flex items-center gap-1 text-[11px] mt-1.5 ${nameOk ? "text-emerald-700" : "text-gray-400"}`}>
                {nameOk && <CheckCircle className="w-3.5 h-3.5" aria-hidden="true" />}{nameOk ? t("brand_name_ok") : t("brand_name_hint", { min: BRAND_LIMITS.BRAND_NAME_MIN, max: BRAND_LIMITS.BRAND_NAME_MAX })}
              </span>
            </label>
            {data.brandingOptions?.length > 0 && (
              <div className="space-y-2" role="radiogroup" aria-label={t("optional_services")}>
                <NumTitle n={4}>{t("optional_services")}</NumTitle>
                {[{ id: "", label: t("branding_none"), description: "" }, ...data.brandingOptions].map((o) => {
                  const on = brandingOptionId === o.id;
                  return (
                    <button key={o.id || "none"} type="button" role="radio" aria-checked={on} onClick={() => setBrandingOptionId(o.id)}
                      className={`w-full flex items-start justify-between gap-3 text-start rounded-2xl border-2 p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${on ? "border-violet-500 bg-violet-50/40" : "border-gray-100"}`}>
                      <span className="min-w-0">
                        <span dir="auto" className="block text-sm font-bold text-gray-900">{o.label}</span>
                        {o.description && <span dir="auto" className="block text-xs text-gray-500 mt-0.5 whitespace-pre-line">{o.description}</span>}
                      </span>
                      <span className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${on ? "bg-violet-600 text-white" : "border-2 border-gray-200 text-transparent"}`} aria-hidden="true"><Check className="w-3.5 h-3.5" /></span>
                    </button>
                  );
                })}
              </div>
            )}
            {nav(nameOk)}
          </>
        )}

        {step === 3 && pkg && (
          <>
            <NumTitle n={data.brandingOptions?.length > 0 ? 5 : 4}>{t("review_title")}</NumTitle>
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 text-sm space-y-1">
              <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_package")}</span><span dir="auto" className="font-semibold text-gray-800">{pkg.name}</span></p>
              <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_brand")}</span><span dir="auto" className="font-semibold text-gray-800">{cleanName}</span></p>
              {option && <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_branding")}</span><span dir="auto" className="font-semibold text-gray-800">{option.label}</span></p>}
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-600 mb-2">{t("review_products")}</p>
              <ProductList products={chosen} />
            </div>
            <Breakdown b={pkg.breakdown} t={t} money={money} />

            <div>
              <p className="text-xs font-semibold text-gray-600 mb-1">{t("terms_title")}</p>
              {terms ? (
                <>
                  <div dir="auto" className="max-h-48 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-700 whitespace-pre-line leading-relaxed">{terms.text}</div>
                  <p className="text-[11px] text-gray-400 mt-1">{t("terms_version", { v: terms.version })}</p>
                  <label className="flex items-start gap-2 mt-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" className="mt-1 w-4 h-4 accent-violet-600" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                    {t("accept_terms", { v: terms.version })}
                  </label>
                </>
              ) : <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">{t("terms_missing")}</p>}
            </div>

            {error && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => { setError(null); setStep(2); }} className={BTN_GHOST}><Back className="w-4 h-4" aria-hidden="true" />{t("back")}</button>
              <button type="button" onClick={buy} disabled={!canBuy} className={`flex-1 ${BTN_PRIMARY}`}>
                {sending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{sending ? t("sending") : t("buy_now")}{!sending && <Fwd className="w-4 h-4" aria-hidden="true" />}
              </button>
            </div>
          </>
        )}
        {step !== 3 && error && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>}
      </div>
    </div>
  );
}

/** Brand header (reference "My Brand"): monogram, name, package as category, status chips. */
function BrandHeader({ access, t, status, sinceDays }) {
  const letter = (access.brandName || "?").trim().charAt(0).toUpperCase();
  return (
    <div className={`${CARD} p-4 sm:p-5`} data-brand-header>
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gray-950 ring-2 ring-amber-400/70 flex items-center justify-center shrink-0" aria-hidden="true">
          <span className="text-3xl sm:text-4xl font-black text-amber-400 font-serif">{letter}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-violet-600">{t("my_brand")}</p>
          <p dir="auto" className="text-xl sm:text-2xl font-black text-gray-900 leading-tight truncate">{access.brandName}</p>
          <p dir="auto" className="text-xs text-gray-500 mt-0.5 truncate">{access.package?.name}{access.branding?.label ? ` · ${access.branding.label}` : ""}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {status === "ACTIVE"
          ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 text-xs font-bold"><CheckCircle className="w-3.5 h-3.5" aria-hidden="true" />{t("chip_active")}</span>
          : status === "CLOSED"
          ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold"><Info className="w-3.5 h-3.5" aria-hidden="true" />{t("chip_closed")}</span>
          : <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-amber-50 text-amber-800 text-xs font-bold"><Clock className="w-3.5 h-3.5" aria-hidden="true" />{t("chip_pending")}</span>}
        {sinceDays !== null && <span className="px-2.5 py-1 rounded-xl bg-gray-50 border border-gray-100 text-gray-600 text-xs font-semibold">{t("since_days", { n: sinceDays })}</span>}
      </div>
    </div>
  );
}

/** Bank details + transfer proof upload for a request awaiting payment (one proof per request). */
function PaymentProof({ access, t, onChanged }) {
  const [bankInfo, setBankInfo] = useState(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch("/api/setting?type=bank-settings")
      .then((r) => r.json())
      .then((d) => { const methods = Array.isArray(d?.methods) ? d.methods : []; setBankInfo(methods[0] || (d && (d.rib || d.bankName) ? d : null)); })
      .catch(() => {});
  }, []);
  const proof = access.paymentProof;
  if (proof) {
    return (
      <p role="status" className="text-sm text-gray-700 bg-gray-50 rounded-xl px-3 py-2 flex items-center gap-1.5">
        <CheckCircle className="w-4 h-4 text-emerald-600" aria-hidden="true" />{t(proof.status === "SUBMITTED" ? "proof_received" : "proof_reviewed")}
      </p>
    );
  }
  const select = (f) => {
    if (!f) return;
    if (!PROOF_ACCEPT.split(",").includes(f.type)) { setError(t("code_INVALID_FILE")); return; }
    if (f.size > PROOF_MAX_BYTES) { setError(t("code_FILE_TOO_LARGE")); return; }
    setError(null); setFile(f); setPreview(f.type === "application/pdf" ? "pdf" : URL.createObjectURL(f));
  };
  const submit = async () => {
    if (!file || busy) return;
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.append("paymentMethod", "Virement bancaire");
    if (reference.trim()) fd.append("transferReference", reference.trim());
    fd.append("proof", file);
    let r;
    try {
      const res = await fetch(`/api/affiliate/brand/access/${encodeURIComponent(access.id)}/proof`, { method: "POST", headers: authHeaders(), body: fd });
      r = { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch { r = { ok: false, status: 0, data: null }; }
    setBusy(false);
    if (r.ok) onChanged(); else setError(errorText(r, t));
  };
  return (
    <div className="space-y-3" data-brand-proof>
      <p className="text-xs text-gray-600">{t("pending_payment_step")}</p>
      <BankDetailsCard bankInfo={bankInfo} labels={{ title: t("proof_bank_title") }} />
      <label className="block">
        <span className="block text-xs font-semibold text-gray-600 mb-1">{t("proof_reference")}</span>
        <input dir="auto" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120}
          className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 focus:outline-none focus:border-gray-400" />
      </label>
      <ProofUploadCard preview={preview} previewIsPdf={preview === "pdf"} onSelectFile={select} onRemove={() => { setFile(null); setPreview(null); }}
        accept={PROOF_ACCEPT} labels={{ title: t("proof_title") }} />
      <button type="button" onClick={submit} disabled={busy || !file} className={`${BTN_PRIMARY} w-full`}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{t("proof_submit")}
      </button>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

/**
 * Fresh consent to the CURRENT published terms (separate record; the terms
 * accepted with the request are never changed). Explicit checkbox, no implied consent.
 */
function ConsentRenewal({ access, terms, t, onChanged }) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!terms) return null;
  const submit = async () => {
    if (!accepted || busy) return;
    setBusy(true); setError(null);
    const r = await call(`/api/affiliate/brand/access/${encodeURIComponent(access.id)}/consent`, {
      method: "POST", body: { termsVersion: terms.version, acceptTerms: true },
    });
    setBusy(false);
    if (r.ok) onChanged(); else setError(errorText(r, t));
  };
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-2" data-consent-renewal>
      <p className="text-sm font-bold text-gray-900">{t("consent_renew_title")}</p>
      <p className="text-xs text-gray-600">{t("consent_renew_body")}</p>
      <div dir="auto" className="max-h-48 overflow-y-auto whitespace-pre-line text-xs text-gray-700 bg-white rounded-lg border border-gray-100 p-2">{terms.text}</div>
      <label className="flex items-start gap-2 text-xs text-gray-700">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5" />
        <span>{t("consent_renew_accept")}</span>
      </label>
      <button type="button" onClick={submit} disabled={!accepted || busy}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-900 text-white disabled:opacity-50">
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}{t("consent_renew_submit")}
      </button>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function PendingCard({ access, terms, t, money, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const cancel = async () => {
    if (typeof window !== "undefined" && !window.confirm(t("cancel_confirm"))) return;
    setBusy(true);
    const r = await call(`/api/affiliate/brand/access/${encodeURIComponent(access.id)}/cancel`, { method: "POST" });
    setBusy(false);
    if (r.ok) onChanged(); else setError(errorText(r, t));
  };
  return (
    <div className="space-y-4">
      <BrandHeader access={access} t={t} status={access.status} sinceDays={null} />
      <div className={`${CARD} p-4 sm:p-5 space-y-3`}>
        <p className="text-sm font-black text-gray-900 flex items-center gap-1.5"><Clock className="w-4 h-4 text-amber-500" aria-hidden="true" />{t("pending_title")}</p>
        <p className="text-sm text-gray-700">{t("pending_body")}</p>
        <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 text-sm space-y-1">
          <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_brand")}</span><span dir="auto" className="font-semibold text-gray-800">{access.brandName}</span></p>
          <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_package")}</span><span dir="auto" className="font-semibold text-gray-800">{access.package?.name}</span></p>
          {access.branding?.label && <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_branding")}</span><span dir="auto" className="font-semibold text-gray-800">{access.branding.label}</span></p>}
          <p className="flex justify-between gap-3"><span className="text-gray-500">{t("bd_total")}</span><span className="font-black text-violet-600">{money(access.amount)}</span></p>
        </div>
        {access.products?.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-2">{t("review_products")}</p>
            <ProductList products={access.products} />
          </div>
        )}
        {access.package?.breakdown && <Breakdown b={access.package.breakdown} t={t} money={money} />}
        {access.consentStatus === "PAYMENT_BLOCKED" || access.consentStatus === "RENEWED_PAYMENT_BLOCKED" ? (
          <div className="space-y-3">
            <p role="status" className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
              {t(access.consentStatus === "RENEWED_PAYMENT_BLOCKED" ? "consent_renewed_payment_blocked" : "consent_payment_blocked")}
            </p>
            {access.consentStatus === "PAYMENT_BLOCKED" && <ConsentRenewal access={access} terms={terms} t={t} onChanged={onChanged} />}
          </div>
        ) : (
          <PaymentProof access={access} t={t} onChanged={onChanged} />
        )}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button type="button" onClick={cancel} disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100 disabled:opacity-50">
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}{t("cancel_request")}
        </button>
      </div>
    </div>
  );
}

/** Active / closed brand: loads the simulated dashboard (refreshed while active) and renders _brand/BrandDashboard. */
function ActiveDashboard({ access, t, lang, dir, locale, money }) {
  const [windowKey, setWindowKey] = useState("7d");
  const [dash, setDash] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fmtDate = (d) => (d ? new Date(d).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—");
  const sinceDays = access.activatedAt ? Math.max(0, Math.floor((Date.now() - new Date(access.activatedAt).getTime()) / DAY_MS)) : null;

  const load = useCallback(async () => {
    setLoading(true);
    const r = await call(`/api/affiliate/brand/dashboard?window=${windowKey}`);
    setLoading(false);
    if (r.ok) { setDash(r.data); setError(null); } else setError(errorText(r, t));
  }, [windowKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // "See all": one page of the simulated orders of the period the list was opened with, frozen at its
  // `asOf` instant (same API, same dataset). The live dashboard above keeps polling normally.
  const loadPage = useCallback(async (page, asOf, win, listId) => {
    const w = win || windowKey;
    const r = await call(`/api/affiliate/brand/dashboard?window=${w}&page=${page}${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ""}${listId ? `&list=${listId}` : ""}`);
    return r.ok ? r.data?.orders || null : null;
  }, [windowKey]);

  const closed = access.status === "CLOSED";
  useEffect(() => {
    load();
    if (closed) return undefined; // read-only: the closed view never changes
    const id = setInterval(() => { if (!document.hidden) load(); }, DASHBOARD_POLL_MS);
    return () => clearInterval(id);
  }, [load, closed]);

  return (
    <BrandDashboard access={access} dash={dash} error={error} loading={loading} windowKey={windowKey} onWindow={setWindowKey}
      t={t} lang={lang} dir={dir} locale={locale} money={money} fmtDate={fmtDate} sinceDays={sinceDays} loadPage={loadPage} />
  );
}

export default function BrandTab() {
  const { lang } = useLanguage();
  const t = brandT(lang);
  const dir = brandDir(lang);
  const locale = lang === "ar" ? "ar-MA" : "fr-FR";
  const money = (n) => `${Number(n || 0).toLocaleString(locale, { maximumFractionDigits: 2 })} MAD`;

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const r = await call("/api/affiliate/brand");
    if (r.ok) { setData(r.data); setError(null); } else setError(errorText(r, t));
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  if (!data) {
    return (
      <div dir={dir} className="flex justify-center py-16 text-start">
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : <Loader2 className="w-7 h-7 animate-spin text-gray-400" />}
      </div>
    );
  }

  const access = data.access;
  // text-start: the site sets `text-align: left` on <body> (inherited); "start" follows each element's own direction.
  if (access?.status === "ACTIVE") return <div dir={dir} className="max-w-3xl mx-auto text-start"><ActiveDashboard access={access} t={t} lang={lang} dir={dir} locale={locale} money={money} /></div>;
  if (access?.status === "CLOSED") {
    return (
      <div dir={dir} className="max-w-3xl mx-auto space-y-5 text-start">
        <ActiveDashboard access={access} t={t} lang={lang} dir={dir} locale={locale} money={money} />
        {access.consentStatus === "RENEWAL_REQUIRED" && <ConsentRenewal access={access} terms={data.terms} t={t} onChanged={load} />}
        {access.consentStatus === "RENEWED" && <p role="status" className="text-xs text-gray-600 bg-gray-50 rounded-xl px-3 py-2">{t("consent_renewed")}</p>}
        {data.enabled && (
          <>
            <p className="text-xs text-gray-600 bg-gray-50 rounded-xl px-3 py-2">{t("closed_new_request")}</p>
            <Offer data={data} t={t} money={money} dir={dir} onRequested={load} onStale={load} />
          </>
        )}
      </div>
    );
  }

  return (
    <div dir={dir} className="max-w-3xl mx-auto space-y-5 text-start">
      {access?.status === "PENDING_PAYMENT" ? (
        <>
          <PendingCard access={access} terms={data.terms} t={t} money={money} onChanged={load} />
          <WhatYouBuy t={t} />
        </>
      ) : (
        <>
          {access?.status === "REJECTED" && (
            <div role="status" className="bg-red-50 border border-red-100 rounded-2xl p-4 text-sm text-red-800">
              <p className="font-bold flex items-center gap-1.5"><XCircle className="w-4 h-4" aria-hidden="true" />{t("rejected_title")}</p>
              {access.rejectionReason && <p dir="auto" className="mt-1">{t("rejected_reason", { reason: access.rejectionReason })}</p>}
              {data.enabled && <p className="mt-1">{t("can_retry")}</p>}
            </div>
          )}
          {data.enabled ? <Offer data={data} t={t} money={money} dir={dir} onRequested={load} onStale={load} />
            : (
              <>
                <WhatYouBuy t={t} />
                <p className={`${CARD} text-sm text-gray-500 p-6 text-center`}>{t("disabled")}</p>
              </>
            )}
        </>
      )}
    </div>
  );
}
