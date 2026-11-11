"use client";

/**
 * 🏪 Create Your Own Brand — paid TRAINING SIMULATOR (affiliate side).
 *
 *   no access   → the guided flow, with a five-step progress indicator (_brand/Stepper):
 *                 (1) landing — purple hero + the pack cards: cover image, name,
 *                     category, product count, pieces, price, total payable, short
 *                     description and included services; ONE pack is chosen (radio
 *                     cards), "details" opens step 2, the big button continues;
 *                 (2) details of the chosen pack — gallery with a zoom viewer
 *                     (_brand/PackGallery), contents = the pack's products with
 *                     their quantities, specifications, services, price, pieces.
 *                     The pack DEFINES its products: nothing is picked;
 *                 (3) the fictional brand name + an automatic preview
 *                     (_brand/BrandPreview) + the optional branding service;
 *                 (4) review — pack, contents, name, services, itemised costs,
 *                     VAT, total, PUBLISHED refund terms — "Buy Now"
 *   pending     → (5) brand header (pending), products, saved breakdown, bank
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
 * the APIs; this UI never decides eligibility, never sends an amount, never sends
 * products and never sends an affiliate id. The affiliate's real earnings and
 * statistics stay in their own dashboard tabs; nothing here reads or shows them.
 * Language follows the site (FR/AR) like the Rewards tab, with a local `dir`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2, Store, CheckCircle, Clock, Info, XCircle, GraduationCap, Package,
  ArrowLeft, ArrowRight, Crown, Check, Boxes, Layers, BarChart3, ShieldCheck, Landmark, FileText, BadgeCheck, Sparkles, Tag, Wallet, Sun, CalendarDays,
} from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { brandT, brandDir, BRAND_TEXT } from "@/lib/brandI18n";
import { knownServerError } from "@/lib/serverText/affiliateServerText";
import { useMarketLocale } from "@/context/useMarketLocale";
import { BRAND_LIMITS, normalizeBrandName } from "@/lib/brandProgram";
import { AFFILIATE_TABS_TEXT } from "@/lib/affiliateTabsI18n";
import { makeMarketT } from "@/lib/marketLocale";
import { displayBreakdown } from "@/lib/brandPricing";
import BrandDashboard from "./_brand/BrandDashboard";
import Stepper from "./_brand/Stepper";
import PackGallery from "./_brand/PackGallery";
import BrandPreview from "./_brand/BrandPreview";
import BankDetailsCard from "@/components/checkout/BankDetailsCard";
import ProofUploadCard from "@/components/checkout/ProofUploadCard";

const DASHBOARD_POLL_MS = 60_000;
const DAY_MS = 86_400_000;
const CARD = "bg-white rounded-2xl border border-gray-100 shadow-sm";
const BTN_PRIMARY = "inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-2xl text-sm font-black bg-violet-600 text-white shadow-md shadow-violet-200 hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 disabled:opacity-40 disabled:shadow-none";
const BTN_GHOST = "inline-flex items-center justify-center gap-1.5 px-4 py-3 rounded-2xl text-sm font-semibold bg-white border border-gray-200 text-gray-700 hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400";
/** Index of the verification / activation step in the progress indicator (the pending screen). */
const STEP_VERIFY = 4;

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
// One-line, bidi-isolated text (brand / pack names typed in any script) that aligns with the page direction and is
// cut at its OWN end: a `truncate` on an RTL block would cut a Latin name at its start.
const ISO_TRUNC = "inline-block max-w-full truncate align-top";
const PROOF_MAX_BYTES = 8 * 1024 * 1024; // same limit as the server (DEPOSIT_MAX_BYTES), checked again there

// Brand error CODES → this tab's dictionary (code_*). Anything else the server can answer (generic 500
// SERVER_ERROR, shared rate limiter, auth middleware) → the affiliate server-text table; else generic.
const errorText = (r, t, lang) => {
  if (r.status === 0) return t("error_network");
  const code = r.data?.code;
  if (code && BRAND_TEXT.fr[`code_${code}`] !== undefined) return t(`code_${code}`, { n: r.data.expected ?? "" });
  return knownServerError(r.data || {}, lang) ?? t("error_generic");
};

/** Cover of a pack: the first image of its gallery (the API already falls back to its products' images). */
const packCover = (p) => p?.images?.[0] || (p?.products || []).find((pr) => pr.image)?.image || null;

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

/**
 * Read-only list of a pack's products (thumbnail + name + quantity when the admin set one), used on the details,
 * review and pending views. The quantity is a figure, shown as "× n" (no text to translate).
 */
function ProductList({ products }) {
  if (!products?.length) return null;
  return (
    <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2" data-product-list>
      {products.map((p) => (
        <li key={p.id} className="relative rounded-xl border border-gray-100 bg-white overflow-hidden">
          <Thumb src={p.image} iconCls="w-6 h-6" />
          {p.quantity ? (
            <span dir="ltr" className="absolute top-1.5 end-1.5 px-1.5 py-0.5 rounded-lg bg-violet-600 text-white text-[11px] font-black shadow-sm" data-product-qty>× {p.quantity}</span>
          ) : null}
          <p className="px-2 py-1.5 text-[11px] font-semibold text-gray-800"><span dir="auto" className="line-clamp-2">{p.title}</span></p>
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

/** Included services (the pack's features), green check list. */
function ServiceList({ items, t, className = "" }) {
  if (!items?.length) return null;
  return (
    <ul className={`space-y-1.5 ${className}`} aria-label={t("features_title")}>
      {items.map((f) => (
        <li key={f} dir="auto" className="flex items-start gap-2 text-xs text-gray-700">
          <span className="w-4 h-4 mt-px rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0" aria-hidden="true"><Check className="w-2.5 h-2.5" /></span>{f}
        </li>
      ))}
    </ul>
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

/** A pack image (its cover); a missing or failing image shows the package icon. */
function PackImage({ src, alt = "", className = "" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <span className={`flex items-center justify-center overflow-hidden ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && !failed ? <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="max-w-full max-h-full object-contain" />
        : <Package className="w-10 h-10 text-violet-300" aria-hidden="true" />}
    </span>
  );
}

const HERO_CHIPS = [["hero_chip_training", GraduationCap], ["hero_chip_sim", BarChart3], ["hero_chip_verified", ShieldCheck]];

/** Landing hero: purple gradient, title, chips and the offered packs' own cover images (nothing invented). */
function Landing({ t, packages }) {
  const images = [];
  for (const p of packages) { const src = packCover(p); if (src && !images.includes(src) && images.length < 3) images.push(src); }
  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-violet-700 via-violet-600 to-fuchsia-500 text-white p-5 sm:p-7 shadow-lg shadow-violet-200" data-hero>
      <div aria-hidden="true" className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
      <div aria-hidden="true" className="absolute -bottom-12 end-24 w-28 h-28 rounded-full bg-fuchsia-300/20" />
      <div className="relative flex items-center gap-3 sm:gap-6">
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-white/15 text-white text-[11px] font-bold"><GraduationCap className="w-3 h-3" aria-hidden="true" />{t("training_badge")}</span>
          <h2 className="text-2xl sm:text-4xl font-black leading-tight mt-2">{t("title")}</h2>
          <p className="text-lg sm:text-2xl font-black text-violet-100 leading-tight" dir="ltr">{t("title_en")}</p>
          <p className="text-[13px] sm:text-base text-violet-50/90 mt-2 leading-snug max-w-xl">{t("landing_intro")}</p>
        </div>
        <div className="relative w-24 sm:w-44 h-28 sm:h-44 shrink-0" aria-hidden="true">
          {images.length ? images.map((src, i) => (
            <div key={src} className="absolute w-16 sm:w-28 rounded-2xl overflow-hidden shadow-lg ring-2 ring-white bg-white"
              style={{ insetInlineEnd: `${i * 14}px`, top: `${i * 16}px`, zIndex: 3 - i, transform: `rotate(${(i - 1) * 6}deg)` }}>
              <Thumb src={src} iconCls="w-6 h-6" />
            </div>
          )) : <div className="absolute inset-0 flex items-center justify-center"><Store className="w-14 h-14 text-white/80" /></div>}
        </div>
      </div>
      <ul className="relative flex flex-wrap gap-1.5 sm:gap-2 mt-4" data-hero-chips>
        {HERO_CHIPS.map(([k, Icon]) => (
          <li key={k} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white text-violet-800 text-[11px] sm:text-xs font-bold shadow-sm">
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />{t(k)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One pack in the comparison (radio card): cover image, name, category, product count, physical pieces (when
 * configured), price, total payable, availability, then its short description and main services. "Details"
 * chooses the pack and opens step 2 (its full details); the selected card shows "selected ✓". Every value is
 * the admin's configuration of THIS pack.
 */
function PackCard({ p, on, single, tabStop, onSelect, onDetails, onArrow, radioRef, t, money }) {
  return (
    <div data-package-id={p.id} data-selected={on ? "true" : "false"}
      className={`relative snap-start shrink-0 flex flex-col rounded-3xl border-2 bg-white p-3.5 transition-colors ${single ? "w-full sm:max-w-sm sm:mx-auto" : "w-[80%] max-w-[300px] sm:w-auto sm:max-w-none"} ${on ? "border-violet-600 shadow-lg shadow-violet-100" : "border-gray-100 shadow-sm"}`}>
      {on && <span className="absolute -top-3 end-3 w-8 h-8 rounded-full bg-violet-600 text-white flex items-center justify-center ring-4 ring-white z-10" aria-hidden="true" data-check><Check className="w-4 h-4" /></span>}
      <button type="button" role="radio" aria-checked={on} tabIndex={tabStop ? 0 : -1} ref={radioRef}
        onClick={() => onSelect(p.id)} onKeyDown={(e) => { if (onArrow(p.id, e.key)) e.preventDefault(); }}
        className="flex flex-col items-center text-center rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
        <PackImage src={packCover(p)} className="w-full h-32 sm:h-36 rounded-2xl bg-gradient-to-b from-violet-50 to-white p-2" />
        <span dir="auto" className="block text-lg font-black text-gray-900 mt-2 leading-tight">{p.name}</span>
        {p.category ? <span dir="auto" className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[11px] font-bold" data-pack-category><Tag className="w-3 h-3" aria-hidden="true" />{p.category}</span> : null}
        <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 mt-1.5"><Package className="w-3.5 h-3.5" aria-hidden="true" />{t("package_products", { n: p.productCount })}</span>
        {p.quantity ? <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 mt-0.5" data-pack-quantity><Boxes className="w-3.5 h-3.5" aria-hidden="true" />{t("pack_pieces", { n: p.quantity })}</span> : null}
        <span className="block w-full mt-2 rounded-2xl bg-violet-50 py-1.5 text-2xl font-black text-violet-700" data-pack-price><bdi className="whitespace-nowrap">{money(p.price)}</bdi></span>
        <span className="block text-[11px] text-gray-500 mt-1">{t("total_payable_short")} : <span className="font-bold text-violet-700">{money(p.breakdown.total)}</span></span>
        <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />{t("pack_available")}
        </span>
      </button>
      {p.description && <p dir="auto" className="text-xs text-gray-600 mt-2 line-clamp-2" data-pack-description>{p.description}</p>}
      {p.features?.length > 0 && (
        <ul className="space-y-1.5 mt-2 rounded-2xl bg-gray-50/80 p-2.5" aria-label={t("features_title")}>
          {p.features.slice(0, 3).map((f) => (
            <li key={f} dir="auto" className="flex items-start gap-2 text-xs text-gray-700">
              <span className="w-4 h-4 mt-px rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0" aria-hidden="true"><Check className="w-2.5 h-2.5" /></span>{f}
            </li>
          ))}
        </ul>
      )}
      <div className="flex-1" />
      <button type="button" onClick={() => onDetails(p.id)} data-pack-details-toggle
        className={`mt-3 w-full min-h-[44px] inline-flex items-center justify-center gap-1.5 py-2.5 rounded-2xl text-sm font-black focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 ${on ? "bg-violet-600 text-white shadow-md shadow-violet-200 hover:bg-violet-700" : "border-2 border-violet-600 text-violet-700 bg-white hover:bg-violet-50"}`}>
        {on ? <><Check className="w-4 h-4" aria-hidden="true" />{t("pack_selected")}<span className="sr-only"> · {t("package_details_show")}</span></> : t("package_details_show")}
      </button>
    </div>
  );
}

const TRUST = [["trust_training", GraduationCap], ["trust_payment", Landmark], ["trust_terms", FileText], ["trust_activation", BadgeCheck]];

/** Facts of the offer only (no invented promise): simulated training, verified transfer, published terms, activation after verification. */
function TrustStrip({ t }) {
  return (
    <ul className={`${CARD} grid grid-cols-2 lg:grid-cols-4 gap-3 p-3 sm:p-4`} data-trust>
      {TRUST.map(([k, Icon]) => (
        <li key={k} className="flex items-center gap-2 min-w-0 text-xs font-bold text-gray-800 leading-snug">
          <span className="w-9 h-9 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0" aria-hidden="true"><Icon className="w-[18px] h-[18px]" /></span>
          <span className="min-w-0">{t(k)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Small section heading inside a step card. */
/**
 * The request, in four screens (the fifth step is the pending view):
 * (1) choose ONE package — every package shows its price and total up front,
 * (2) its details as a visual showcase: cover + its own products (quantities) with zoom, products / pieces / price,
 * (3) name the brand (automatic preview + optional branding service),
 * (4) review — package, contents, name, services, itemised costs, VAT, total,
 * refund terms — and "Buy Now". The package defines its products: none are sent.
 * The server re-checks everything and computes the amount itself.
 */
/**
 * Step 2 gallery items: the admin's pack cover (when it is not already one of the product photos), then each product of
 * the pack with its quantity — never anything outside the pack. A pack with neither keeps its card cover.
 */
function galleryItems(pkg) {
  const products = Array.isArray(pkg?.products) ? pkg.products : [];
  const productImages = new Set(products.map((p) => p.image).filter(Boolean));
  const cover = Array.isArray(pkg?.images) ? pkg.images[0] : null;
  const items = [];
  // The cover has no caption: the pack name is already the step's title.
  if (cover && !productImages.has(cover)) items.push({ key: "cover", src: cover, title: null, quantity: null });
  for (const p of products) items.push({ key: `p-${p.id}`, src: p.image || null, title: p.title, quantity: p.quantity ?? null });
  if (!items.length) items.push({ key: "cover", src: packCover(pkg), title: null, quantity: null });
  return items;
}

/** Pieces in the pack: the admin's total, else the sum of its products' quantities when every one is set; else null. */
function packPieces(pkg) {
  if (Number.isInteger(pkg?.quantity) && pkg.quantity > 0) return pkg.quantity;
  const qs = (pkg?.products || []).map((p) => p.quantity);
  return qs.length && qs.every((q) => Number.isInteger(q) && q > 0) ? qs.reduce((a, b) => a + b, 0) : null;
}

/** One compact figure of step 2 (icon, value, short label). */
function DetailStat({ Icon, value, label, ...rest }) {
  return (
    <li className="rounded-2xl border border-violet-100 bg-white px-3 py-2.5 flex items-center gap-2.5 shadow-sm" {...rest}>
      <span className="w-9 h-9 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0" aria-hidden="true"><Icon className="w-[18px] h-[18px]" /></span>
      <span className="min-w-0">
        <span className="block text-lg font-black text-gray-900 leading-none tabular-nums"><bdi>{value}</bdi></span>
        <span className="block text-[11px] font-semibold text-gray-500 mt-1 truncate">{label}</span>
      </span>
    </li>
  );
}

/** One admin-entered estimate of step 2 (informational, labelled as an estimate; never computed here). */
function EstimateChip({ Icon, label, value, ...rest }) {
  return (
    <li className="rounded-2xl bg-amber-50/70 border border-amber-100 px-3 py-2 flex items-center gap-2" {...rest}>
      <span className="w-8 h-8 rounded-xl bg-white text-amber-500 flex items-center justify-center shrink-0 shadow-sm" aria-hidden="true"><Icon className="w-4 h-4" /></span>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold leading-tight text-amber-800">{label}</span>
        <bdi className="block text-sm font-black text-gray-900 whitespace-nowrap">{value}</bdi>
      </span>
    </li>
  );
}

function Offer({ data, t, lang, money, dir, onRequested, onStale }) {
  const packages = data.packages || [];
  const [step, setStep] = useState(0);
  // Nothing is pre-selected: the affiliate compares the packs and picks one.
  const [packageId, setPackageId] = useState(null);
  const [brandName, setBrandName] = useState("");
  const [brandingOptionId, setBrandingOptionId] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const requestId = useRef(null);
  const radios = useRef({});
  const stepBox = useRef(null);
  const shownStep = useRef(step);

  const pkg = packages.find((p) => p.id === packageId) || null;
  const Back = dir === "rtl" ? ArrowRight : ArrowLeft;
  const Fwd = dir === "rtl" ? ArrowLeft : ArrowRight;

  // After a reload (PACKAGE_NOT_FOUND / TERMS_CHANGED): a vanished package sends the affiliate back to the choice.
  useEffect(() => {
    if (packageId && !packages.some((p) => p.id === packageId)) { setPackageId(null); setAccepted(false); setStep(0); }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // New published terms must be accepted again.
  useEffect(() => { setAccepted(false); }, [data.terms?.version]);
  // Each step starts at the top of the tab (phones); keyboard / screen-reader focus moves to the new step.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    stepBox.current?.focus({ preventScroll: true });
  }, [step]);

  // Back on the pack choice (e.g. "change pack"): the selected card is brought into view in the phone carousel.
  useEffect(() => {
    if (step !== 0 || !packageId) return;
    radios.current[packageId]?.scrollIntoView?.({ block: "nearest", inline: "center", behavior: "auto" });
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another pack: nothing from the previous one is kept (consent given on its review, retry key of its request).
  const pickPackage = (id) => {
    if (id === packageId) return;
    setPackageId(id); setAccepted(false); requestId.current = null;
  };
  const openDetails = (id) => { pickPackage(id); setError(null); setStep(1); };
  // Radio group keyboard: arrows move the choice (reading direction aware), focus follows it.
  const onArrow = (fromId, key) => {
    const delta = { ArrowDown: 1, ArrowUp: -1, ArrowRight: dir === "rtl" ? -1 : 1, ArrowLeft: dir === "rtl" ? 1 : -1 }[key];
    if (!delta || !packages.length) return false;
    const i = packages.findIndex((p) => p.id === fromId);
    const next = packages[(i + delta + packages.length) % packages.length];
    pickPackage(next.id);
    radios.current[next.id]?.focus();
    return true;
  };

  const option = data.brandingOptions?.find((o) => o.id === brandingOptionId) || null;
  const terms = data.terms;
  const cleanName = brandName.replace(/\s+/g, " ").trim();
  const nameLenOk = cleanName.length >= BRAND_LIMITS.BRAND_NAME_MIN && cleanName.length <= BRAND_LIMITS.BRAND_NAME_MAX;
  const nameOk = nameLenOk && normalizeBrandName(cleanName) !== null; // same rule as the server
  const nameBadChars = nameLenOk && !nameOk;
  const canBuy = !!pkg && nameOk && !!terms && accepted && !sending;

  const buy = async () => {
    if (!canBuy) return;
    setSending(true);
    setError(null);
    requestId.current = requestId.current || newRequestId(); // a retried click reuses the same key
    const r = await call("/api/affiliate/brand/access", {
      method: "POST",
      body: {
        packageId: pkg.id, brandName: cleanName, brandingOptionId: option?.id || null,
        termsVersion: terms.version, acceptTerms: true, clientRequestId: requestId.current,
      },
    });
    setSending(false);
    if (r.ok) { requestId.current = null; onRequested(); return; }
    if (r.status !== 0) requestId.current = null;
    setError(errorText(r, t, lang));
    if (r.data?.code === "INVALID_BRAND_NAME") setStep(2); // back to the field that needs fixing
    if (["PACKAGE_NOT_FOUND", "TERMS_CHANGED"].includes(r.data?.code)) {
      onStale();
      if (r.data.code === "PACKAGE_NOT_FOUND") setStep(0);
    }
  };

  const nav = (canNext) => (
    <div className="flex gap-2 pt-1">
      <button type="button" onClick={() => { setError(null); setStep(step - 1); }} className={BTN_GHOST}><Back className="w-4 h-4" aria-hidden="true" />{t("back")}</button>
      <button type="button" onClick={() => setStep(step + 1)} disabled={!canNext} className={`flex-1 ${BTN_PRIMARY}`}>{t("next")}<Fwd className="w-4 h-4" aria-hidden="true" /></button>
    </div>
  );

  // ── Step 1: landing + package selection ────────────────────────────────────
  if (step === 0) {
    const tabStopId = pkg ? pkg.id : packages[0]?.id;
    return (
      <div ref={stepBox} tabIndex={-1} className="space-y-5 focus:outline-none" data-flow-step="1">
        <Landing t={t} packages={packages} />
        <Stepper current={0} t={t} />
        <WhatYouBuy t={t} />

        <section className="space-y-3" data-packs>
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-2xl bg-white border border-violet-100 shadow-sm text-violet-600 flex items-center justify-center shrink-0" aria-hidden="true"><Layers className="w-5 h-5" /></span>
            <div className="min-w-0">
              <h3 id="brand-packs-title" className="text-xl sm:text-2xl font-black text-violet-950">{t("packages_section")}</h3>
              <p className="text-xs sm:text-sm text-gray-500 mt-0.5">{t("pack_compare_sub")}</p>
            </div>
          </div>
          {packages.length ? (
            <>
              <div role="radiogroup" aria-labelledby="brand-packs-title"
                className={packages.length === 1 ? "pt-3" : "-mx-4 px-4 scroll-px-4 pt-3 pb-2 flex items-stretch gap-3 overflow-x-auto snap-x snap-mandatory sm:mx-0 sm:scroll-px-0 sm:px-0 sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:overflow-visible"}>
                {packages.map((p) => (
                  <PackCard key={p.id} p={p} on={p.id === packageId} single={packages.length === 1} tabStop={p.id === tabStopId}
                    radioRef={(el) => { radios.current[p.id] = el; }} onArrow={onArrow}
                    onSelect={pickPackage} onDetails={openDetails} t={t} money={money} />
                ))}
              </div>
              <TrustStrip t={t} />
              {error && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>}
              <button type="button" onClick={() => { setError(null); setStep(1); }} disabled={!pkg} data-start
                className={`w-full ${BTN_PRIMARY} py-4 text-base bg-gradient-to-r from-violet-700 to-violet-500`}>
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

  // ── Steps 2–4: guided creation ─────────────────────────────────────────────
  return (
    <div ref={stepBox} tabIndex={-1} className="max-w-3xl mx-auto space-y-4 focus:outline-none" data-flow-step={step + 1}>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => { setError(null); setStep(step - 1); }} aria-label={t("back")}
          className="w-10 h-10 rounded-full flex items-center justify-center text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"><Back className="w-5 h-5" /></button>
        <h2 className="flex-1 text-center text-lg font-black text-gray-900 pe-10">{t("create_title")}</h2>
      </div>
      <Stepper current={step} t={t} />

      {pkg && step > 1 && (
        <button type="button" onClick={() => { setError(null); setStep(0); }} className={`${CARD} w-full flex items-center gap-3 px-3 py-2.5 text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400`} data-pack-summary>
          <PackImage src={packCover(pkg)} className="w-11 h-11 rounded-xl bg-violet-50 shrink-0" />
          <span className="min-w-0 flex-1"><span className="block text-[11px] text-gray-500">{t("review_package")}</span><span dir="auto" className="block text-sm font-black text-gray-900 truncate">{pkg.name}</span></span>
          <span className="text-end shrink-0"><span className="block text-[11px] text-gray-500">{t("total_payable_short")}</span><span className="block text-sm font-black text-violet-700">{money(pkg.breakdown.total)}</span></span>
        </button>
      )}

      <div className={`${CARD} p-4 sm:p-5 space-y-4`}>
        {step === 1 && pkg && (
          <>
            {/* Step 2 = a visual showcase of the chosen pack: images first (cover + its own products with quantities,
                zoom), then a few compact figures. Description, specifications, services and disclosures stay in the
                admin config / API and are shown on the pack card (step 1) and the review (step 4), not repeated here. */}
            <NumTitle n={2}>{t("details_title")}</NumTitle>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start" data-pack-details={pkg.id}>
              <PackGallery items={galleryItems(pkg)} name={pkg.name} t={t} dir={dir} />
              <div className="min-w-0 space-y-3">
                <div className="space-y-1.5">
                  <p dir="auto" className="text-xl sm:text-2xl font-black text-gray-900 leading-tight">{pkg.name}</p>
                  {pkg.category ? <p className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-violet-50 text-violet-700 text-xs font-bold"><Tag className="w-3.5 h-3.5" aria-hidden="true" /><span className="sr-only">{t("pack_category")} : </span><span dir="auto">{pkg.category}</span></p> : null}
                </div>
                <div className="rounded-3xl bg-gradient-to-br from-violet-600 to-purple-700 text-white px-4 py-3.5 shadow-md shadow-violet-200 flex items-center gap-3" data-details-price>
                  <span className="w-11 h-11 rounded-2xl bg-white/15 flex items-center justify-center shrink-0" aria-hidden="true"><Wallet className="w-5 h-5" /></span>
                  <span className="min-w-0">
                    <span className="block text-[11px] font-bold text-violet-100">{t("bd_price")}</span>
                    <bdi className="block text-2xl sm:text-3xl font-black leading-tight whitespace-nowrap">{money(pkg.price)}</bdi>
                    <span className="block text-[11px] text-violet-100 mt-0.5">{t("total_payable_short")} : <bdi className="font-black text-white whitespace-nowrap">{money(pkg.breakdown.total)}</bdi></span>
                  </span>
                </div>
                <ul className="grid grid-cols-2 gap-2" aria-label={t("details_title")} data-details-stats>
                  <DetailStat Icon={Package} value={pkg.productCount} label={t("details_stat_products")} />
                  {packPieces(pkg) !== null && <DetailStat Icon={Boxes} value={packPieces(pkg)} label={t("details_stat_pieces")} data-details-pieces />}
                </ul>
                {(pkg.estimatedDailyEarnings || pkg.estimatedMonthlyEarnings) ? (
                  <div className="space-y-1.5" data-details-estimates>
                    <ul className="grid grid-cols-2 gap-2" aria-label={t("est_title")}>
                      {pkg.estimatedDailyEarnings ? <EstimateChip Icon={Sun} label={t("est_daily")} value={money(pkg.estimatedDailyEarnings)} data-estimate="daily" /> : null}
                      {pkg.estimatedMonthlyEarnings ? <EstimateChip Icon={CalendarDays} label={t("est_monthly")} value={money(pkg.estimatedMonthlyEarnings)} data-estimate="monthly" /> : null}
                    </ul>
                    <p className="text-[11px] text-gray-500 flex items-center gap-1"><Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />{t("est_note")}</p>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => { setError(null); setStep(0); }} className={BTN_GHOST} data-change-pack><Back className="w-4 h-4" aria-hidden="true" />{t("details_change")}</button>
              <button type="button" onClick={() => setStep(2)} className={`flex-1 ${BTN_PRIMARY}`} data-details-next>{t("next")}<Fwd className="w-4 h-4" aria-hidden="true" /></button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <NumTitle n={3}>{t("flow_brand")}</NumTitle>
            <BrandPreview name={brandName} packName={pkg?.name} t={t} />
            <label className="block">
              <span className="block text-sm font-bold text-gray-800 mb-1.5">{t("brand_name")}</span>
              <span className="relative block">
                <Crown className="absolute top-1/2 -translate-y-1/2 start-3 w-5 h-5 text-gray-700" aria-hidden="true" />
                <input dir="auto" value={brandName} maxLength={BRAND_LIMITS.BRAND_NAME_MAX} onChange={(e) => { setBrandName(e.target.value); if (error) setError(null); }} name="brandName"
                  className="w-full text-base border border-gray-200 rounded-2xl ps-11 pe-3 py-3 bg-white [unicode-bidi:plaintext] focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-violet-400" />
              </span>
              <span className={`flex items-center gap-1 text-[11px] mt-1.5 ${nameOk ? "text-emerald-700" : nameBadChars ? "text-red-600" : "text-gray-400"}`} aria-live="polite" data-name-status>
                {nameOk && <CheckCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                {nameOk ? t("brand_name_ok") : nameBadChars ? t("brand_name_bad_chars") : t("brand_name_hint", { min: BRAND_LIMITS.BRAND_NAME_MIN, max: BRAND_LIMITS.BRAND_NAME_MAX })}
              </span>
            </label>
            {data.brandingOptions?.length > 0 && (
              <div className="space-y-2 rounded-2xl border border-dashed border-violet-200 bg-violet-50/30 p-3" role="radiogroup" aria-labelledby="brand-optional-title" data-branding-options>
                <h4 id="brand-optional-title" className="flex items-center gap-1.5 text-sm font-black text-gray-900"><Sparkles className="w-4 h-4 text-violet-600" aria-hidden="true" />{t("optional_services")}</h4>
                <p className="text-xs text-gray-600">{t("branding_optional_note")}</p>
                {[{ id: "", label: t("branding_none"), description: "" }, ...data.brandingOptions].map((o) => {
                  const on = brandingOptionId === o.id;
                  return (
                    <button key={o.id || "none"} type="button" role="radio" aria-checked={on} onClick={() => setBrandingOptionId(o.id)}
                      className={`w-full min-h-[44px] flex items-start justify-between gap-3 text-start rounded-2xl border-2 bg-white p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${on ? "border-violet-500 bg-violet-50/40" : "border-gray-100"}`}>
                      <span className="min-w-0">
                        <span dir="auto" className="block text-sm font-bold text-gray-900">{o.label}</span>
                        {o.description && <span dir="auto" className="block text-xs text-gray-500 mt-0.5 whitespace-pre-line">{o.description}</span>}
                      </span>
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${on ? "bg-violet-600 text-white" : "border-2 border-gray-300 text-transparent"}`} aria-hidden="true"><Check className="w-3.5 h-3.5" /></span>
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
            <NumTitle n={4}>{t("flow_review")}</NumTitle>
            <div className="flex items-start gap-3 rounded-xl bg-gray-50 border border-gray-100 p-3" data-review-pack>
              <PackImage src={packCover(pkg)} alt={pkg.name} className="w-20 h-20 rounded-xl bg-white border border-gray-100 p-1 shrink-0" />
              <div className="min-w-0 flex-1 text-sm space-y-1">
                <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_package")}</span><span dir="auto" className="font-semibold text-gray-800 min-w-0 break-words">{pkg.name}</span></p>
                {pkg.category ? <p className="flex justify-between gap-3"><span className="text-gray-500">{t("pack_category")}</span><span dir="auto" className="font-semibold text-gray-800 min-w-0 break-words">{pkg.category}</span></p> : null}
                <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_brand")}</span><span dir="auto" className="font-semibold text-gray-800 min-w-0 break-words">{cleanName}</span></p>
                {option && <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_branding")}</span><span dir="auto" className="font-semibold text-gray-800 min-w-0 break-words">{option.label}</span></p>}
                {pkg.quantity ? <p className="flex justify-between gap-3"><span className="text-gray-500">{t("pack_pieces_label")}</span><span className="font-semibold text-gray-800">{pkg.quantity}</span></p> : null}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-600 mb-2">{t("details_contents")}</p>
              <ProductList products={pkg.products} />
            </div>
            {pkg.features?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-600 mb-2">{t("details_services")}</p>
                <ServiceList items={pkg.features} t={t} />
              </div>
            )}
            <Breakdown b={pkg.breakdown} t={t} money={money} />

            <div>
              <p className="text-xs font-semibold text-gray-600 mb-1">{t("terms_title")}</p>
              {terms ? (
                <>
                  <div dir="auto" className="max-h-48 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-700 whitespace-pre-line leading-relaxed">{terms.text}</div>
                  <p className="text-[11px] text-gray-400 mt-1">{t("terms_version", { v: terms.version })}</p>
                  <label className="flex items-start gap-2 mt-2 text-sm text-gray-700 cursor-pointer min-h-[40px]">
                    <input type="checkbox" className="mt-1 w-5 h-5 accent-violet-600 shrink-0" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
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
  const reviewing = status !== "ACTIVE" && status !== "CLOSED" && access.paymentProof?.status === "SUBMITTED";
  const letter = (access.brandName || "?").trim().charAt(0).toUpperCase();
  return (
    <div className={`${CARD} p-4 sm:p-5`} data-brand-header>
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gray-950 ring-2 ring-amber-400/70 flex items-center justify-center shrink-0" aria-hidden="true">
          <span className="text-3xl sm:text-4xl font-black text-amber-400 font-serif">{letter}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-violet-600">{t("my_brand")}</p>
          <p className="text-xl sm:text-2xl font-black text-gray-900 leading-tight"><bdi dir="auto" className={ISO_TRUNC}>{access.brandName}</bdi></p>
          <p className="text-xs text-gray-500 mt-0.5"><bdi dir="auto" className={ISO_TRUNC}>{access.package?.name}{access.branding?.label ? ` · ${access.branding.label}` : ""}</bdi></p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {status === "ACTIVE"
          ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 text-xs font-bold"><CheckCircle className="w-3.5 h-3.5" aria-hidden="true" />{t("chip_active")}</span>
          : status === "CLOSED"
          ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold"><Info className="w-3.5 h-3.5" aria-hidden="true" />{t("chip_closed")}</span>
          : <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-amber-50 text-amber-800 text-xs font-bold"><Clock className="w-3.5 h-3.5" aria-hidden="true" />{t(reviewing ? "chip_review" : "chip_pending")}</span>}
        {sinceDays !== null && <span className="px-2.5 py-1 rounded-xl bg-gray-50 border border-gray-100 text-gray-600 text-xs font-semibold">{t("since_days", { n: sinceDays })}</span>}
      </div>
    </div>
  );
}

/** Bank details + transfer proof upload for a request awaiting payment (one proof per request). */
function PaymentProof({ access, t, lang, onChanged }) {
  const { dir: marketDir } = useMarketLocale(null);
  // Bank card + upload box labels in the market language: the Deposit tab's texts (same file types, same 8 MB limit).
  const dt = makeMarketT(AFFILIATE_TABS_TEXT, lang);
  const bankLabels = { bankName: dt("dep_bank_name"), accountHolder: dt("dep_bank_holder"), accountNumber: dt("dep_bank_account"), copy: dt("dep_copy"), copied: dt("dep_copied") };
  const uploadLabels = { click: dt("dep_upload_click"), drag: dt("dep_upload_drag"), uploaded: dt("dep_upload_done"), processing: dt("dep_upload_processing") };
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
    if (r.ok) onChanged(); else setError(errorText(r, t, lang));
  };
  return (
    <div className="space-y-3" data-brand-proof>
      <p className="text-xs text-gray-600">{t("pending_payment_step")}</p>
      <BankDetailsCard bankInfo={bankInfo} labels={{ ...bankLabels, title: t("proof_bank_title") }} dir={marketDir} valueDir="ltr" />
      <label className="block">
        <span className="block text-xs font-semibold text-gray-600 mb-1">{t("proof_reference")}</span>
        <input dir="auto" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120}
          className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 focus:outline-none focus:border-gray-400 [unicode-bidi:plaintext]" />
      </label>
      <ProofUploadCard preview={preview} previewIsPdf={preview === "pdf"} onSelectFile={select} onRemove={() => { setFile(null); setPreview(null); }}
        accept={PROOF_ACCEPT} labels={{ ...uploadLabels, title: t("proof_title"), previewAlt: t("proof_title") }} />
      {error && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2" data-proof-error>{error}</p>}
      <button type="button" onClick={submit} disabled={busy || !file} className={`${BTN_PRIMARY} w-full`}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{t("proof_submit")}
      </button>
    </div>
  );
}

/**
 * Fresh consent to the CURRENT published terms (separate record; the terms
 * accepted with the request are never changed). Explicit checkbox, no implied consent.
 */
function ConsentRenewal({ access, terms, t, lang, onChanged }) {
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
    if (r.ok) onChanged(); else setError(errorText(r, t, lang));
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

function PendingCard({ access, terms, t, lang, money, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const cancel = async () => {
    if (typeof window !== "undefined" && !window.confirm(t("cancel_confirm"))) return;
    setBusy(true);
    const r = await call(`/api/affiliate/brand/access/${encodeURIComponent(access.id)}/cancel`, { method: "POST" });
    setBusy(false);
    if (r.ok) onChanged(); else setError(errorText(r, t, lang));
  };
  return (
    <div className="space-y-4" data-flow-step="5">
      <Stepper current={STEP_VERIFY} t={t} />
      <BrandHeader access={access} t={t} status={access.status} sinceDays={null} />
      <div className={`${CARD} p-4 sm:p-5 space-y-3`}>
        <NumTitle n={STEP_VERIFY + 1}>{t("flow_verify")}</NumTitle>
        <p className="text-sm font-black text-gray-900 flex items-center gap-1.5"><Clock className="w-4 h-4 text-amber-500" aria-hidden="true" />{t(access.paymentProof?.status === "SUBMITTED" ? "pending_title_review" : "pending_title")}</p>
        <p className="text-sm text-gray-700">{t("pending_body")}</p>
        <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 text-sm space-y-1">
          <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_brand")}</span><span dir="auto" className="font-semibold text-gray-800">{access.brandName}</span></p>
          <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_package")}</span><span dir="auto" className="font-semibold text-gray-800">{access.package?.name}</span></p>
          {access.package?.category ? <p className="flex justify-between gap-3"><span className="text-gray-500">{t("pack_category")}</span><span dir="auto" className="font-semibold text-gray-800">{access.package.category}</span></p> : null}
          {access.branding?.label && <p className="flex justify-between gap-3"><span className="text-gray-500">{t("review_branding")}</span><span dir="auto" className="font-semibold text-gray-800">{access.branding.label}</span></p>}
          <p className="flex justify-between gap-3"><span className="text-gray-500">{t("bd_total")}</span><span className="font-black text-violet-600">{money(access.amount)}</span></p>
        </div>
        {access.products?.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-2">{t("details_contents")}</p>
            <ProductList products={access.products} />
          </div>
        )}
        {access.package?.breakdown && <Breakdown b={access.package.breakdown} t={t} money={money} />}
        {access.consentStatus === "PAYMENT_BLOCKED" || access.consentStatus === "RENEWED_PAYMENT_BLOCKED" ? (
          <div className="space-y-3">
            <p role="status" className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
              {t(access.consentStatus === "RENEWED_PAYMENT_BLOCKED" ? "consent_renewed_payment_blocked" : "consent_payment_blocked")}
            </p>
            {access.consentStatus === "PAYMENT_BLOCKED" && <ConsentRenewal access={access} terms={terms} t={t} lang={lang} onChanged={onChanged} />}
          </div>
        ) : (
          <PaymentProof access={access} t={t} lang={lang} onChanged={onChanged} />
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
  // Same time zone as the order times (BrandDashboard): Morocco time, whatever the browser's zone.
  const fmtDate = (d) => (d ? new Date(d).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Casablanca" }) : "—");
  const sinceDays = access.activatedAt ? Math.max(0, Math.floor((Date.now() - new Date(access.activatedAt).getTime()) / DAY_MS)) : null;

  const load = useCallback(async () => {
    setLoading(true);
    const r = await call(`/api/affiliate/brand/dashboard?window=${windowKey}`);
    setLoading(false);
    if (r.ok) { setDash(r.data); setError(null); } else setError(errorText(r, t, lang));
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
  // Amount unchanged (same locale / rounding); the currency label follows the site rule (fr « DH », ar via the dictionary).
  const money = (n) => `${Number(n || 0).toLocaleString(locale, { maximumFractionDigits: 2 })} ${t("currency")}`;

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const r = await call("/api/affiliate/brand");
    if (r.ok) { setData(r.data); setError(null); } else setError(errorText(r, t, lang));
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
        {access.consentStatus === "RENEWAL_REQUIRED" && <ConsentRenewal access={access} terms={data.terms} t={t} lang={lang} onChanged={load} />}
        {access.consentStatus === "RENEWED" && <p role="status" className="text-xs text-gray-600 bg-gray-50 rounded-xl px-3 py-2">{t("consent_renewed")}</p>}
        {data.enabled && (
          <>
            <p className="text-xs text-gray-600 bg-gray-50 rounded-xl px-3 py-2">{t("closed_new_request")}</p>
            <Offer data={data} t={t} lang={lang} money={money} dir={dir} onRequested={load} onStale={load} />
          </>
        )}
      </div>
    );
  }

  const pending = access?.status === "PENDING_PAYMENT";
  return (
    <div dir={dir} className={`${pending ? "max-w-3xl" : "max-w-5xl"} mx-auto space-y-5 text-start`}>
      {pending ? (
        <>
          <PendingCard access={access} terms={data.terms} t={t} lang={lang} money={money} onChanged={load} />
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
          {data.enabled ? <Offer data={data} t={t} lang={lang} money={money} dir={dir} onRequested={load} onStale={load} />
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
