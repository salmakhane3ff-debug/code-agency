"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Star, Check, X, Zap, Home, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { fetchCached } from "@/lib/dataCache";
import StickyCTA from "@/components/Product/StickyCTA";
import InlineCodForm from "@/components/Product/InlineCodForm";
import { resolveCtaAction, isCtaDisabled } from "@/lib/landingCta";
import { resolveClickId } from "@/lib/tracking/clickId";
import { trackClarity } from "@/lib/trackClarity";
import { useMarketLocale, useMarketPaintGate } from "@/context/useMarketLocale";
import { LANDING_TEXT } from "@/lib/landingI18n";

// Visitor-facing chrome follows the market (MA → Arabic/RTL, FR → French/LTR).
// Admin-authored content (titles, HTML, custom labels, product data) is shown as authored.
const useLandingT = () => useMarketLocale(LANDING_TEXT);

// The shared COD form (also used by the product page, which keeps its Arabic defaults) with the
// visitor's market texts and direction; the phone field resolves its own direction (dir="auto") so
// the typed number always reads left-to-right.
function LandingCodForm(props) {
  const { t, dir } = useLandingT();
  const text = {
    successTitle: t("offer_form_success_title"), successSub: t("offer_form_success_sub"), heading: t("offer_form_heading"),
    name: t("offer_form_name"), phone: t("offer_form_phone"), city: t("offer_form_city"), address: t("offer_form_address"),
    error: t("offer_form_error"), sending: t("offer_form_sending"), submit: t("offer_order_now"),
  };
  return <InlineCodForm {...props} text={text} dir={dir} phoneDir="auto" />;
}

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function imgSrc(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  return v.url || v.src || "";
}


function Stars({ rating, size = "sm" }) {
  const r   = Math.round(rating || 0);
  const cls = size === "lg" ? "w-5 h-5" : "w-3.5 h-3.5";
  return (
    <div className="flex items-center gap-0.5">
      {[1,2,3,4,5].map((s) => (
        <Star key={s} className={`${cls} ${s <= r ? "fill-amber-400 text-amber-400" : "fill-gray-200 text-gray-200"}`} />
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  COUNTDOWN TIMER
// ══════════════════════════════════════════════════════════════════════════════

function useCountdown(endDate) {
  const calc = () => {
    if (!endDate) return null;
    const diff = new Date(endDate).getTime() - Date.now();
    if (diff <= 0) return { h: 0, m: 0, s: 0 };
    const s = Math.floor(diff / 1000);
    return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  };
  const [time, setTime] = useState(calc);
  useEffect(() => {
    if (!endDate) return;
    const id = setInterval(() => setTime(calc()), 1000);
    return () => clearInterval(id);
  }, [endDate]);
  return time;
}

function CountdownDisplay({ endDate, title, bgColor }) {
  const time = useCountdown(endDate);
  if (!time) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return (
    <div className="rounded-2xl p-4 text-white text-center" style={{ background: bgColor || "#ef4444" }}>
      {title && <p className="text-xs font-bold uppercase tracking-widest mb-2 text-white/80">{title}</p>}
      <div className="flex items-center justify-center gap-3">
        {[["h", time.h], ["m", time.m], ["s", time.s]].map(([unit, val]) => (
          <div key={unit} className="flex flex-col items-center">
            <span className="text-3xl font-black tabular-nums">{pad(val)}</span>
            <span className="text-[10px] uppercase tracking-widest text-white/70">{unit}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  REVIEWS SECTION
// ══════════════════════════════════════════════════════════════════════════════

function ReviewsSection({ productId }) {
  const { t } = useLandingT();
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!productId) { setLoading(false); return; }
    fetch(`/api/reviews?productId=${productId}`)
      .then((r) => r.json())
      .then((d) => setReviews(Array.isArray(d) ? d : []))
      .catch(() => setReviews([]))
      .finally(() => setLoading(false));
  }, [productId]);
  if (loading) return (
    <div className="space-y-3 animate-pulse">
      {[1,2].map((i) => (
        <div key={i} className="bg-white rounded-2xl p-4 border border-gray-100">
          <div className="h-3 w-28 bg-gray-100 rounded mb-2" />
          <div className="h-3 w-full bg-gray-100 rounded mb-1" />
          <div className="h-3 w-2/3 bg-gray-100 rounded" />
        </div>
      ))}
    </div>
  );
  if (!reviews.length) return null;
  return (
    <div className="space-y-3">
      {reviews.map((r, i) => (
        <div key={r._id || i} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 text-xs font-bold">
                {(r.name || t("offer_avatar_fallback"))[0].toUpperCase()}
              </div>
              <span className="text-sm font-semibold text-gray-900">{r.name}</span>
            </div>
            <Stars rating={r.rating} />
          </div>
          {r.message && <p className="text-sm text-gray-600 leading-relaxed">{r.message}</p>}
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO COUNTDOWN (resets every X hours based on stored timestamp)
// ══════════════════════════════════════════════════════════════════════════════

function useAutoCountdown(resetHours = 4) {
  const storageKey = `lp_countdown_${resetHours}`;
  const getEnd = () => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const end = parseInt(stored, 10);
        if (end > Date.now()) return end;
      }
    } catch {}
    const end = Date.now() + resetHours * 3600 * 1000;
    try { localStorage.setItem(storageKey, String(end)); } catch {}
    return end;
  };
  const calc = (endTs) => {
    const diff = endTs - Date.now();
    if (diff <= 0) return { h: 0, m: 0, s: 0 };
    const s = Math.floor(diff / 1000);
    return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  };
  const [endTs]  = useState(getEnd);
  const [time, setTime] = useState(() => calc(endTs));
  useEffect(() => {
    const id = setInterval(() => setTime(calc(endTs)), 1000);
    return () => clearInterval(id);
  }, [endTs]);
  return time;
}

function AutoCountdownDisplay({ cfg }) {
  const { t } = useLandingT();
  const { resetHours = 4, title = t("offer_countdown_default_title"), bgColor = "#dc2626" } = cfg;
  const time = useAutoCountdown(resetHours);
  const pad  = (n) => String(n).padStart(2, "0");
  return (
    <div className="rounded-2xl p-4 text-white text-center" style={{ background: bgColor }}>
      {title && <p className="text-xs font-bold uppercase tracking-widest mb-2 text-white/80">{title}</p>}
      <div className="flex items-center justify-center gap-3">
        {[["h", time.h], ["m", time.m], ["s", time.s]].map(([unit, val]) => (
          <div key={unit} className="flex flex-col items-center">
            <span className="text-3xl font-black tabular-nums">{pad(val)}</span>
            <span className="text-[10px] uppercase tracking-widest text-white/70">{unit}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  VIEWER COUNT (animated random number)
// ══════════════════════════════════════════════════════════════════════════════

function ViewerCountDisplay({ cfg }) {
  const { t } = useLandingT();
  const { min = 18, max = 35, label = t("offer_viewers_default_label"), icon = "👁️" } = cfg;
  const rand = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
  const [count, setCount] = useState(() => rand(min, max));
  useEffect(() => {
    const id = setInterval(() => {
      setCount((c) => {
        const delta = Math.random() < 0.5 ? 1 : -1;
        return Math.max(min, Math.min(max, c + delta));
      });
    }, 7000);
    return () => clearInterval(id);
  }, [min, max]);
  return (
    <div className="flex items-center justify-center gap-2 py-2.5 px-4 bg-indigo-50 rounded-2xl border border-indigo-100">
      <span className="text-base">{icon}</span>
      <span className="text-sm font-black text-indigo-700" dir="ltr">{count}</span>
      <span className="text-xs text-indigo-600">{label}</span>
      <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  ACTIVITY POPUP (floating "Ahmed from Casablanca just ordered")
// ══════════════════════════════════════════════════════════════════════════════

// Extract first usable image URL from a product record (handles all DB formats)
function getProductImg(product) {
  const imgs = product?.images;
  if (!imgs) return null;
  if (typeof imgs === "string") return imgs;
  if (Array.isArray(imgs) && imgs.length > 0) {
    const first = imgs[0];
    return first?.url || first?.src || (typeof first === "string" ? first : null);
  }
  return null;
}

function ActivityPopup({ cfg, product }) {
  const { t, dir } = useLandingT();
  const { items = [], intervalSec = 8, displaySec = 4 } = cfg;
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState(0);

  // Use this landing page's own product image — no fetch needed
  const productImage = getProductImg(product);

  useEffect(() => {
    if (!items.length) return;
    const show = () => {
      setCurrent((i) => (i + 1) % items.length);
      setVisible(true);
      setTimeout(() => setVisible(false), displaySec * 1000);
    };
    const delay = setTimeout(show, 3000); // first popup after 3s
    const id    = setInterval(show, intervalSec * 1000);
    return () => { clearTimeout(delay); clearInterval(id); };
  }, [items.length, intervalSec, displaySec]);

  const person = items[current] || {};
  if (!visible || !person.name) return null;

  return (
    // Pinned to the inline END side (left in RTL — unchanged — right in LTR), sliding in from that edge.
    <div className={`fixed bottom-24 end-4 z-50 animate-in ${dir === "rtl" ? "slide-in-from-left-4" : "slide-in-from-right-4"} duration-300`}>
      <div className="flex items-center gap-3 bg-white rounded-2xl shadow-xl border border-gray-100 px-4 py-3 max-w-[240px]">
        {/* Landing-page product image — falls back to initials if no image available */}
        <div className="w-9 h-9 rounded-full flex-shrink-0 overflow-hidden bg-amber-100">
          {productImage ? (
            <img
              src={productImage}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-amber-600 text-base font-bold select-none">
              {(person.name || t("offer_avatar_fallback"))[0]}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-black text-gray-900 leading-tight">{t("offer_popup_from", { name: person.name, city: person.city })}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">{t("offer_popup_just_ordered")}</p>
        </div>
        <button onClick={() => setVisible(false)} aria-label={t("common_close")} className="text-gray-300 hover:text-gray-500 me-1 flex-shrink-0">
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  DYNAMIC BLOCK RENDERER
// ══════════════════════════════════════════════════════════════════════════════

function BlockRenderer({ block, product, landingPage, onBuyNow, onCta, hasOrderForm, ctaFocus, buying }) {
  const { t } = useLandingT();
  const { type, config: cfg = {}, visible } = block;
  if (visible === false) return null;

  switch (type) {

    case "hero": {
      const heroImg = cfg.bgImage || imgSrc((product?.images || [])[0]);
      return (
        <div className="relative w-full bg-gray-900">
          {heroImg
            ? <img src={heroImg} alt={cfg.title || ""} className="w-full max-h-[70vh] object-cover" loading="lazy" style={{ opacity: 1 - (cfg.overlayOpacity ?? 0) }} />
            : <div className="w-full aspect-[4/3] bg-gray-800" />
          }
          <div className="absolute inset-0 flex flex-col justify-end p-5"
            style={{ background: `linear-gradient(to top, rgba(0,0,0,${cfg.overlayOpacity ?? 0.55}), transparent)` }}>
            {cfg.title && <h1 className="text-2xl font-black text-white leading-snug mb-2 drop-shadow">{cfg.title}</h1>}
            {cfg.subtitle && <p className="text-sm text-white/80 leading-relaxed line-clamp-2 mb-3">{cfg.subtitle}</p>}
            {cfg.buttonText !== "" && (
              <button onClick={onBuyNow} disabled={buying || !product}
                className="self-start flex items-center gap-2 px-5 py-2.5 font-black text-white rounded-2xl transition-all shadow-lg active:scale-[0.98] disabled:opacity-70"
                style={{ background: cfg.buttonColor || "#f59e0b" }}>
                <Zap className="w-4 h-4" />
                {buying ? t("offer_redirecting") : (cfg.buttonText || t("offer_order_now"))}
              </button>
            )}
          </div>
        </div>
      );
    }

    case "image": {
      if (!cfg.src) return null;
      // Full Bleed (Edge-to-Edge): zero spacing so consecutive full-bleed images
      // stack into ONE continuous page with no gaps. `display:block` +
      // `line-height:0` kill the inline-image descender whitespace, so the images
      // touch each other and the container (= mobile viewport) edges perfectly.
      if (cfg.fullBleed) {
        return (
          <>
            <img
              src={cfg.src}
              alt={cfg.alt || ""}
              loading="lazy"
              className="block w-full h-auto align-top"
              style={{ margin: 0, padding: 0, border: "none", borderRadius: 0, display: "block", width: "100%", height: "auto", lineHeight: 0 }}
            />
            {cfg.caption && <p className="text-xs text-gray-400 text-center px-4 py-2">{cfg.caption}</p>}
          </>
        );
      }
      // Default (unchanged): padded, rounded — normal single-image behaviour.
      return (
        <div className="px-4 py-2">
          <img src={cfg.src} alt={cfg.alt || ""} loading="lazy"
            className={`rounded-2xl ${cfg.fullWidth !== false ? "w-full" : "mx-auto max-w-sm"}`} />
          {cfg.caption && <p className="text-xs text-gray-400 text-center mt-2">{cfg.caption}</p>}
        </div>
      );
    }

    case "text":
      return (
        <div className="px-4 py-3">
          <div className="bg-white rounded-2xl border border-gray-100 p-5 text-sm text-gray-700 leading-relaxed prose prose-sm max-w-none"
            style={{ textAlign: cfg.align || "start" /* start = right in RTL (unchanged), left in LTR */ }}
            dangerouslySetInnerHTML={{ __html: cfg.content || "" }}
          />
        </div>
      );

    case "video": {
      if (!cfg.url) return null;
      const isYouTube = cfg.url.includes("youtube.com") || cfg.url.includes("youtu.be");
      const ytId = isYouTube
        ? (cfg.url.match(/(?:v=|youtu\.be\/)([^&?/]+)/)?.[1] || "")
        : "";
      return (
        <div className="px-4 py-3">
          <div className="rounded-2xl overflow-hidden bg-black aspect-video">
            {isYouTube && ytId
              ? <iframe src={`https://www.youtube.com/embed/${ytId}?autoplay=${cfg.autoplay ? 1 : 0}&controls=${cfg.controls !== false ? 1 : 0}`}
                  className="w-full h-full" allowFullScreen allow="autoplay" />
              : <video src={cfg.url} autoPlay={!!cfg.autoplay} controls={cfg.controls !== false} className="w-full h-full object-cover" />
            }
          </div>
          {cfg.caption && <p className="text-xs text-gray-400 text-center mt-2">{cfg.caption}</p>}
        </div>
      );
    }

    case "beforeAfter":
      return (
        <div className="px-4 py-3">
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block text-center">{cfg.beforeLabel || t("offer_before")}</span>
                {cfg.beforeImage
                  ? <img src={cfg.beforeImage} alt={t("offer_before")} loading="lazy" className="w-full aspect-square rounded-xl object-cover" />
                  : <div className="w-full aspect-square rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 text-xs">{t("offer_no_image")}</div>
                }
              </div>
              <div className="space-y-1.5">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block text-center">{cfg.afterLabel || t("offer_after")}</span>
                {cfg.afterImage
                  ? <img src={cfg.afterImage} alt={t("offer_after")} loading="lazy" className="w-full aspect-square rounded-xl object-cover" />
                  : <div className="w-full aspect-square rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 text-xs">{t("offer_no_image")}</div>
                }
              </div>
            </div>
          </div>
        </div>
      );

    case "features":
      return (
        <div className="px-4 py-3">
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            {cfg.title && <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">{cfg.title}</p>}
            <ul className="space-y-3">
              {(cfg.items || []).map((item, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <div className="mt-0.5 w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0 text-sm">
                    {item.icon || "✓"}
                  </div>
                  <div>
                    <span className="text-sm font-semibold text-gray-800">{item.title}</span>
                    {item.desc && <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      );

    case "reviews":
      return (
        <div className="px-4 py-3 space-y-3">
          {cfg.title && (
            <p className="text-sm font-black text-gray-700 flex items-center gap-1.5">
              <Star className="w-4 h-4 fill-amber-400 text-amber-400" /> {cfg.title}
            </p>
          )}
          {/* Builder-defined reviews */}
          {(cfg.items || []).map((r, i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 text-xs font-bold">
                    {(r.name || t("offer_avatar_fallback"))[0].toUpperCase()}
                  </div>
                  <span className="text-sm font-semibold text-gray-900">{r.name}</span>
                </div>
                <Stars rating={r.rating || 5} />
              </div>
              {r.text && <p className="text-sm text-gray-600 leading-relaxed">{r.text}</p>}
            </div>
          ))}
          {/* Live product reviews */}
          {product && (product._id || product.id) && (
            <ReviewsSection productId={product._id || product.id} />
          )}
        </div>
      );

    case "cta":
      return (
        <div className="px-4 py-3">
          <div className="rounded-2xl p-5 text-center" style={{ background: cfg.bgColor || "#fffbeb" }}>
            {cfg.text && <p className="text-base font-black text-gray-800 mb-4">{cfg.text}</p>}
            <button
              // Every CTA block routes through the SAME order-form-aware handler,
              // so multiple CTA instances on one page all work independently.
              onClick={() => onCta(cfg.buttonUrl)}
              // Only the real checkout path can disable. When the action is
              // "scroll to the form" (or redirect), the button is NEVER disabled —
              // so one CTA firing can never freeze another instance.
              disabled={isCtaDisabled({ buttonUrl: cfg.buttonUrl, hasOrderForm, buying, product })}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl font-black text-white text-base transition-all active:scale-[0.98] shadow-lg disabled:opacity-70"
              style={{ background: cfg.buttonColor || "#f59e0b" }}>
              <Zap className="w-5 h-5" />
              {buying && !cfg.buttonUrl && !hasOrderForm ? t("offer_redirecting") : (cfg.buttonText || t("offer_order_now"))}
            </button>
          </div>
        </div>
      );

    case "countdown":
      return (
        <div className="px-4 py-2">
          <CountdownDisplay endDate={cfg.endDate} title={cfg.title} bgColor={cfg.bgColor} />
        </div>
      );

    case "productCard": {
      if (!product) return null;
      const price         = product.salePrice || product.regularPrice;
      const originalPrice = product.salePrice && product.regularPrice && product.regularPrice > product.salePrice
        ? product.regularPrice : null;
      const discountPct   = originalPrice ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0;
      return (
        <div className="px-4 py-3">
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{t("offer_product_label")}</p>
            <h2 className="text-lg font-black text-gray-900 leading-snug mb-3">{product.title}</h2>
            {cfg.showPrice !== false && price != null && (
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-3xl font-black text-gray-900" dir="ltr">
                  {Number(price).toFixed(0)}{" "}
                  <span className="text-base font-bold text-gray-500">{t("offer_currency")}</span>
                </span>
                {originalPrice && <span className="text-base text-gray-400 line-through" dir="ltr">{Number(originalPrice).toFixed(0)} {t("offer_currency")}</span>}
                {discountPct > 0 && <span className="bg-red-100 text-red-600 text-xs font-black px-2 py-0.5 rounded-full" dir="ltr">−{discountPct}%</span>}
              </div>
            )}
            {cfg.showRating !== false && (product.rating || 0) > 0 && (
              <div className="flex items-center gap-2 mb-3">
                <Stars rating={product.rating} />
                <span className="text-xs text-gray-500">{t("offer_rating_count", { rating: product.rating, count: product.reviewsCount || 0 })}</span>
              </div>
            )}
            {cfg.showDescription !== false && product.shortDescription && (
              <p className="text-sm text-gray-600 leading-relaxed mb-4">{product.shortDescription}</p>
            )}
            {cfg.showBuyButton !== false && (
              <button onClick={onBuyNow} disabled={buying || !product}
                className="w-full flex items-center justify-center gap-2 py-3 bg-amber-400 hover:bg-amber-500 text-white rounded-2xl font-black text-sm transition-all active:scale-[0.98] disabled:opacity-70">
                <Zap className="w-4 h-4" />
                {buying ? t("offer_redirecting") : t("offer_order_now")}
              </button>
            )}
          </div>
        </div>
      );
    }

    case "trustBadges":
      return (
        <div className="px-4 py-2">
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(cfg.items || []).map((b, i) => (
                <div key={i} className="flex flex-col items-center gap-1 text-center">
                  <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center text-xl">{b.icon}</div>
                  <span className="text-[10px] font-semibold text-gray-600">{b.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      );

    case "faq": {
      return <FAQBlock cfg={cfg} />;
    }

    case "spacer":
      return <div style={{ height: `${cfg.height || 32}px` }} />;

    case "stockCounter": {
      const count   = cfg.count ?? 5;
      const label   = cfg.label ? cfg.label.replace("{count}", count) : t("offer_stock_default", { count });
      const pct     = Math.min(100, Math.max(5, (count / 20) * 100));
      return (
        <div className="px-4 py-2">
          <div className="bg-red-50 border border-red-100 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">📦</span>
              <p className="text-sm font-black text-red-700">{label}</p>
            </div>
            {cfg.showBar !== false && (
              <div className="w-full h-2.5 bg-red-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-red-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        </div>
      );
    }

    case "autoCountdown":
      return (
        <div className="px-4 py-2">
          <AutoCountdownDisplay cfg={cfg} />
        </div>
      );

    case "viewerCount":
      return (
        <div className="px-4 py-1">
          <ViewerCountDisplay cfg={cfg} />
        </div>
      );

    case "verifiedReviews":
      return (
        <div className="px-4 py-3 space-y-3">
          {cfg.title && (
            <p className="text-sm font-black text-gray-700 flex items-center gap-1.5">
              <span className="text-green-500">✅</span> {cfg.title}
            </p>
          )}
          {(cfg.items || []).map((r, i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center text-green-700 text-xs font-bold">
                    {(r.name || t("offer_avatar_fallback"))[0].toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{r.name}</p>
                    {r.city && <p className="text-[10px] text-gray-400">{r.city}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Stars rating={r.rating || 5} />
                  {r.verified !== false && (
                    <span className="flex items-center gap-1 text-[10px] text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-semibold border border-green-100">
                      <Check className="w-2.5 h-2.5" /> {t("offer_verified")}
                    </span>
                  )}
                </div>
              </div>
              {r.text && <p className="text-sm text-gray-600 leading-relaxed">{r.text}</p>}
            </div>
          ))}
        </div>
      );

    case "customerPhotos": {
      const photos = (cfg.items || []).filter((p) => p.url);
      if (!photos.length) return null;
      return (
        <div className="px-4 py-3">
          {cfg.title && <p className="text-sm font-black text-gray-700 mb-3">📸 {cfg.title}</p>}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {photos.map((p, i) => (
              <div key={i} className="relative rounded-2xl overflow-hidden aspect-square">
                <img src={p.url} alt={p.name || ""} loading="lazy" className="w-full h-full object-cover" />
                {(p.name || p.caption) && (
                  <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1.5 text-[10px] text-white font-semibold truncate">
                    {p.name}{p.caption ? ` · ${p.caption}` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    }

    case "deliveryBadges":
      return (
        <div className="px-4 py-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(cfg.badges || []).map((b, i) => (
              <div key={i} className="flex items-center gap-2 bg-white rounded-xl border border-gray-100 px-3 py-2.5 shadow-sm">
                <span className="text-lg flex-shrink-0">{b.icon}</span>
                <span className="text-xs font-semibold text-gray-700 leading-tight">{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "activityPopup":
      return null; /* rendered as overlay by OfferContent */

    case "socialProof":
      return (
        <div className="px-4 py-2">
          <div className="rounded-2xl p-4 flex items-center justify-around gap-4 flex-wrap" style={{ background: cfg.bgColor || "#f0fdf4" }}>
            {cfg.soldCount && (
              <div className="flex items-center gap-2">
                <span className="text-2xl">🏆</span>
                <div>
                  <p className="text-lg font-black text-gray-900 leading-none">{cfg.soldCount}</p>
                  <p className="text-[10px] text-gray-500">{t("offer_sold_label")}</p>
                </div>
              </div>
            )}
            {cfg.rating && (
              <div className="flex items-center gap-2">
                <span className="text-2xl">⭐</span>
                <div>
                  <p className="text-lg font-black text-gray-900 leading-none">{cfg.rating}</p>
                  <p className="text-[10px] text-gray-500">{cfg.reviewCount ? t("offer_review_count", { count: cfg.reviewCount }) : t("offer_avg_rating")}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      );

    case "imageSlider":
      return (
        <div className="w-full overflow-hidden">
          <ImageSliderBlock cfg={cfg} />
        </div>
      );

    case "imageGrid":
      return <ImageGridBlock cfg={cfg} />;

    case "audio":
      return <AudioBlock cfg={cfg} />;

    case "orderForm":
      return <div id="lp-order-form"><LandingCodForm cfg={cfg} product={product} landingPage={landingPage} focusSignal={ctaFocus} /></div>;

    case "upsell": {
      const lpProds = Array.isArray(landingPage?.products) ? landingPage.products : [];
      return <UpsellBlock cfg={cfg} landingPageProducts={lpProds} />;
    }

    case "feedbackBlock": {
      const pid = product?._id || product?.id;
      return <FeedbackBlockDisplay cfg={cfg} productId={pid} />;
    }

    case "menu": {
      const { logoText, logoImage, links = [], bgColor, textColor, sticky } = cfg;
      return (
        <nav
          className={`flex items-center justify-between px-4 py-3 border-b border-gray-100${sticky ? " sticky top-0 z-40" : ""}`}
          style={{ background: bgColor || "#ffffff" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            {logoImage
              ? <img src={logoImage} alt={logoText || ""} className="h-8 w-auto object-contain" loading="lazy" />
              : logoText
              ? <span className="font-black text-base truncate" style={{ color: textColor || "#111827" }}>{logoText}</span>
              : null
            }
          </div>
          {links.length > 0 && (
            <div className="flex items-center gap-4 flex-shrink-0">
              {links.map((link, i) => (
                <a key={i} href={link.url || "#"}
                  className="text-sm font-medium whitespace-nowrap hover:opacity-70 transition-opacity"
                  style={{ color: textColor || "#111827" }}>
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </nav>
      );
    }

    default:
      return null;
  }
}

// FAQ with accordion (needs local state)
function FAQBlock({ cfg }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="px-4 py-3">
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        {cfg.title && <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">{cfg.title}</p>}
        <div className="space-y-2">
          {(cfg.items || []).map((item, i) => (
            <div key={i} className="border border-gray-100 rounded-xl overflow-hidden">
              <button className="w-full flex items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                onClick={() => setOpen(open === i ? null : i)}>
                <span className="text-start flex-1">{item.q}</span>
                {open === i ? <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />}
              </button>
              {open === i && (
                <div className="px-4 pb-3 text-sm text-gray-600 leading-relaxed bg-gray-50">{item.a}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  IMAGE SLIDER (swipe + auto-slide)
// ══════════════════════════════════════════════════════════════════════════════

function ImageSliderBlock({ cfg }) {
  const { t, dir } = useLandingT();
  const images = cfg.images || [];
  const [idx, setIdx]         = useState(0);
  const touchStart             = useRef(null);
  const prev = () => setIdx((i) => (i - 1 + images.length) % images.length);
  const next = () => setIdx((i) => (i + 1) % images.length);

  useEffect(() => {
    if (!cfg.autoplay || images.length <= 1) return;
    const id = setInterval(next, cfg.interval || 3000);
    return () => clearInterval(id);
  }, [cfg.autoplay, cfg.interval, images.length]);

  const onTouchStart = (e) => { touchStart.current = e.touches[0].clientX; };
  const onTouchEnd   = (e) => {
    if (touchStart.current == null) return;
    const diff = touchStart.current - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 40) { if (diff > 0) next(); else prev(); }
    touchStart.current = null;
  };

  if (!images.length) return null;
  return (
    <div className="relative w-full overflow-hidden select-none"
      onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {/* Track */}
      <div className="flex transition-transform duration-300 ease-out will-change-transform"
        style={{ transform: `translateX(${idx * 100}%)`, direction: "ltr" }}>
        {images.map((src, i) => (
          <img key={i} src={src} alt="" loading="lazy"
            className="w-full flex-shrink-0 object-cover max-h-[80vh]"
            style={{ minWidth: "100%" }} />
        ))}
      </div>
      {/* Arrows */}
      {cfg.showArrows !== false && images.length > 1 && (
        <>
          {/* Previous sits on the inline START side, Next on the END side (RTL: right/left as before; LTR: mirrored). */}
          <button onClick={prev} aria-label={t("common_prev")}
            className="absolute start-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center text-lg font-bold hover:bg-black/60 z-10">
            {dir === "rtl" ? "›" : "‹"}
          </button>
          <button onClick={next} aria-label={t("common_next")}
            className="absolute end-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center text-lg font-bold hover:bg-black/60 z-10">
            {dir === "rtl" ? "‹" : "›"}
          </button>
        </>
      )}
      {/* Dots */}
      {cfg.showDots !== false && images.length > 1 && (
        <div className="absolute bottom-2.5 left-0 right-0 flex justify-center gap-1.5 z-10">
          {images.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)} aria-label={t("offer_slide_n", { n: i + 1 })}
              className={`w-2 h-2 rounded-full transition-all ${i === idx ? "bg-white scale-125" : "bg-white/50"}`} />
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  IMAGE GRID (edge-to-edge)
// ══════════════════════════════════════════════════════════════════════════════

function ImageGridBlock({ cfg }) {
  const images = (cfg.images || []).filter(Boolean);
  if (!images.length) return null;
  const gap  = cfg.gap ?? 0;
  const cols = cfg.mobileColumns || 2;
  return (
    <div
      className="w-full"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: `${gap}px`,
      }}>
      {images.map((src, i) => (
        <img key={i} src={src} alt="" loading="lazy"
          className="w-full object-cover aspect-square" />
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUDIO BLOCK (background audio with browser-policy handling)
// ══════════════════════════════════════════════════════════════════════════════

function AudioBlock({ cfg }) {
  const { t } = useLandingT();
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [ready,   setReady]   = useState(false);

  // Attempt autoplay after first user interaction
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !cfg.url) return;
    el.volume = cfg.volume ?? 0.5;
    el.loop   = cfg.loop !== false;
    if (cfg.autoplay !== false) {
      const tryPlay = () => {
        el.play().then(() => setPlaying(true)).catch(() => {});
        document.removeEventListener("touchstart", tryPlay);
        document.removeEventListener("click", tryPlay);
      };
      document.addEventListener("touchstart", tryPlay, { once: true });
      document.addEventListener("click",      tryPlay, { once: true });
    }
    el.addEventListener("canplay", () => setReady(true), { once: true });
  }, [cfg.url, cfg.autoplay, cfg.loop, cfg.volume]);

  if (!cfg.url) return null;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause(); else el.play().catch(() => {});
    setPlaying(!playing);
  };

  return (
    <div className="px-4 py-2">
      <audio ref={audioRef} src={cfg.url} preload="metadata" />
      <div className="flex items-center gap-3 bg-purple-50 rounded-2xl border border-purple-100 px-4 py-3">
        <button onClick={toggle} aria-label={playing ? t("offer_audio_pause") : t("offer_audio_play")}
          className="w-9 h-9 rounded-full bg-purple-600 text-white flex items-center justify-center flex-shrink-0 hover:bg-purple-700 transition-colors">
          {playing ? (
            <span className="text-xs font-bold">⏸</span>
          ) : (
            <span className="text-xs font-bold">▶</span>
          )}
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-purple-700 truncate">{cfg.label || t("offer_audio_default_label")}</p>
          {!ready && <p className="text-[10px] text-purple-400">{t("offer_audio_loading")}</p>}
          {ready  && <p className="text-[10px] text-purple-400">{playing ? t("offer_audio_playing") : t("offer_audio_tap")}</p>}
        </div>
        <span className="text-purple-400 text-xs">🔊</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  UPSELL BLOCK
// ══════════════════════════════════════════════════════════════════════════════

function UpsellBlock({ cfg, landingPageProducts }) {
  const { t } = useLandingT();
  const [added, setAdded] = useState(false);
  // Try to find the upsell product from the landing page's linked products
  const prod = (landingPageProducts || []).find(
    (p) => p._id === cfg.productId || p.id === cfg.productId
  );
  const image = prod?.images?.[0];
  const origPrice = prod?.regularPrice || prod?.salePrice;
  const specialPrice = cfg.discountPrice
    ? Number(cfg.discountPrice)
    : prod?.salePrice || origPrice;

  return (
    <div className="px-4 py-2">
      <div className={`rounded-2xl border-2 transition-all p-4 ${added ? "border-amber-400 bg-amber-50" : "border-dashed border-gray-200 bg-white"}`}>
        <p className="text-xs font-black text-amber-600 uppercase tracking-widest mb-3">
          💰 {cfg.title || t("offer_upsell_default_title")}
        </p>
        {cfg.description && <p className="text-xs text-gray-500 mb-3">{cfg.description}</p>}
        <div className="flex items-center gap-3">
          {image && (
            <img src={typeof image === "string" ? image : image?.url || ""}
              alt={prod?.title || ""} loading="lazy"
              className="w-16 h-16 rounded-xl object-cover flex-shrink-0 border border-gray-100" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-gray-900 leading-tight mb-1">
              {prod?.title || t("offer_upsell_default_product")}
            </p>
            <div className="flex items-baseline gap-2">
              {specialPrice != null && (
                <span className="text-base font-black text-amber-600" dir="ltr">
                  {Number(specialPrice).toFixed(0)} {t("offer_currency")}
                </span>
              )}
              {origPrice && specialPrice && origPrice > specialPrice && (
                <span className="text-xs text-gray-400 line-through" dir="ltr">
                  {Number(origPrice).toFixed(0)} {t("offer_currency")}
                </span>
              )}
            </div>
          </div>
          <label className="flex items-center cursor-pointer flex-shrink-0">
            <input type="checkbox" checked={added} onChange={(e) => setAdded(e.target.checked)}
              className="w-5 h-5 accent-amber-500 cursor-pointer" />
          </label>
        </div>
        {added && (
          <p className="mt-2 text-xs text-amber-700 font-semibold text-center">
            {t("offer_upsell_added")}
          </p>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  FEEDBACK BLOCK (text + photos + voice — WhatsApp-style)
// ══════════════════════════════════════════════════════════════════════════════

function VoicePlayer({ url }) {
  const { t } = useLandingT();
  const audioRef  = useRef(null);
  const [playing, setPlaying]   = useState(false);
  const [pct,     setPct]       = useState(0);
  const [dur,     setDur]       = useState(0);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onMeta  = () => setDur(el.duration || 0);
    const onTime  = () => setPct(el.duration ? (el.currentTime / el.duration) * 100 : 0);
    const onEnded = () => { setPlaying(false); setPct(0); };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("timeupdate",     onTime);
    el.addEventListener("ended",          onEnded);
    return () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("timeupdate",     onTime);
      el.removeEventListener("ended",          onEnded);
    };
  }, [url]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause(); else el.play().catch(() => {});
    setPlaying(!playing);
  };

  const fmt = (s) => isNaN(s) ? "0:00" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-2 bg-gray-50 rounded-2xl px-3 py-2">
      <audio ref={audioRef} src={url} preload="metadata" />
      <button onClick={toggle} aria-label={playing ? t("offer_audio_pause") : t("offer_audio_play")}
        className="w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center flex-shrink-0 text-[10px]">
        {playing ? "⏸" : "▶"}
      </button>
      <div className="flex-1 relative h-1.5 bg-gray-200 rounded-full overflow-hidden cursor-pointer"
        onClick={(e) => {
          const el = audioRef.current;
          if (!el) return;
          const rect = e.currentTarget.getBoundingClientRect();
          el.currentTime = ((e.clientX - rect.left) / rect.width) * el.duration;
        }}>
        <div className="absolute inset-y-0 left-0 bg-green-500 rounded-full transition-all"
          style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] text-gray-400 w-8 text-end flex-shrink-0" dir="ltr">{fmt(dur)}</span>
    </div>
  );
}

function FeedbackBlockDisplay({ cfg, productId: pageProductId }) {
  const { t } = useLandingT();
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState(null);

  const pid = cfg.productId || pageProductId;

  useEffect(() => {
    const params = new URLSearchParams();
    if (pid) params.set("productId", pid);
    fetchCached(`/api/feedback?${params}`)
      .then((d) => setItems(Array.isArray(d) ? d.slice(0, cfg.limit || 6) : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [pid, cfg.limit]);

  if (loading) return (
    <div className="px-4 py-3 space-y-3 animate-pulse">
      {[1, 2].map((i) => (
        <div key={i} className="bg-white rounded-2xl p-4 space-y-2 border border-gray-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-200" />
            <div className="h-3 bg-gray-200 rounded w-24" />
          </div>
          <div className="h-3 bg-gray-100 rounded w-full" />
          <div className="h-3 bg-gray-100 rounded w-2/3" />
        </div>
      ))}
    </div>
  );

  if (!items.length) return null;

  return (
    <div className="px-4 py-3 space-y-3">
      {cfg.title && (
        <p className="text-sm font-black text-gray-700 flex items-center gap-1.5">
          <span>💬</span> {cfg.title}
        </p>
      )}
      {items.map((fb, i) => {
        const imgs = Array.isArray(fb.images) ? fb.images.filter(Boolean) : [];
        return (
          <div key={fb._id || i} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2.5">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 text-xs font-bold">
                  {(fb.authorName || fb.name || t("offer_avatar_fallback"))[0].toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900 leading-tight">
                    {fb.authorName || fb.name || t("offer_customer_default")}
                  </p>
                  {fb.isVerified && (
                    <span className="text-[10px] text-green-600 font-semibold flex items-center gap-0.5">
                      <Check className="w-2.5 h-2.5" /> {t("offer_verified")}
                    </span>
                  )}
                </div>
              </div>
              {fb.rating > 0 && <Stars rating={fb.rating} />}
            </div>
            {/* Text */}
            {fb.textContent && (
              <p className="text-sm text-gray-600 leading-relaxed">{fb.textContent}</p>
            )}
            {/* Voice */}
            {cfg.showVoice !== false && fb.voiceUrl && (
              <VoicePlayer url={fb.voiceUrl} />
            )}
            {/* Photos */}
            {cfg.showImages !== false && imgs.length > 0 && (
              <div className="grid grid-cols-3 gap-1.5">
                {imgs.map((url, j) => (
                  <button key={j} onClick={() => setLightbox(url)}
                    className="aspect-square rounded-xl overflow-hidden bg-gray-100">
                    <img src={url} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}>
          <button aria-label={t("common_close")} className="absolute top-4 right-4 text-white text-2xl">×</button>
          <img src={lightbox} alt="" className="max-w-full max-h-[90vh] rounded-xl object-contain" />
        </div>
      )}
    </div>
  );
}


// ══════════════════════════════════════════════════════════════════════════════
//  OFFER CONTENT (inner — needs useSearchParams)
// ══════════════════════════════════════════════════════════════════════════════

function OfferContent({ initialLandingPage = null, initialProduct = null }) {
  const { t, dir, lang } = useLandingT();
  useMarketPaintGate(); // first paint: lift the market gate once this page has rendered in the visitor's market
  const { slug }     = useParams();
  const router       = useRouter();
  const searchParams = useSearchParams();

  const campaign  = searchParams.get("campaign") || null;
  const affId     = searchParams.get("aff")      || null;
  const refParam  = searchParams.get("ref")      || null;

  // ── Initialise with server-prefetched data when available ──────────────────
  // If the Server Component passed initial data, start without loading state.
  const [landingPage, setLandingPage] = useState(initialLandingPage);
  const [product,     setProduct]     = useState(initialProduct);
  const [loading,     setLoading]     = useState(!initialLandingPage && !initialProduct);
  const [notFound,    setNotFound]    = useState(false);
  const [buying,      setBuying]      = useState(false);
  // Bumped whenever a CTA scrolls to the order form → InlineCodForm focuses its
  // first input + plays the highlight (same mechanism as the product page).
  const [ctaFocus,    setCtaFocus]    = useState(0);

  const tracked = useRef(false);

  useEffect(() => {
    // Persist affiliate / ref IDs
    if (affId)     { try { localStorage.setItem("affiliateId", affId);   } catch {} }
    if (refParam)  { try { localStorage.setItem("affiliateRef", refParam); } catch {} }

    // Track campaign click
    if (campaign && !tracked.current) {
      tracked.current = true;
      fetch("/api/track/click", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: campaign }),
      }).catch(() => {});
    }

    // ── Skip fetch when server already provided data ───────────────────────
    if (initialLandingPage !== null || initialProduct !== null) return;

    if (!slug) return;

    // 1. Try landing page
    fetch(`/api/landing-page/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((lp) => {
        if (lp && !lp.error) {
          setLandingPage(lp);
          const prod = lp.product || (Array.isArray(lp.products) && lp.products[0]) || null;
          setProduct(prod);
          setLoading(false);
          return;
        }
        // 2. Fallback: product by slug
        fetch(`/api/products?slug=${encodeURIComponent(slug)}`)
          .then((r) => r.json())
          .then((data) => {
            const list  = Array.isArray(data) ? data : [];
            const match = list.find((p) => p.slug === slug);
            if (match) setProduct(match);
            else       setNotFound(true);
          })
          .catch(() => setNotFound(true))
          .finally(() => setLoading(false));
      })
      .catch(() => setNotFound(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll depth tracking ──────────────────────────────────────────────────
  useEffect(() => {
    if (!landingPage) return;
    const lpId = landingPage.id || landingPage._id;
    const fired = new Set();
    const track = (depth) => {
      if (fired.has(depth)) return;
      fired.add(depth);
      fetch("/api/landing/track-click", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ landingPageId: lpId, metadata: { type: "scroll", depth } }),
      }).catch(() => {});
    };
    const onScroll = () => {
      const pct = Math.round(((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight) * 100);
      if (pct >= 25)  track(25);
      if (pct >= 50)  track(50);
      if (pct >= 75)  track(75);
      if (pct >= 95)  track(100);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [landingPage]);

  // ── Time on page tracking ──────────────────────────────────────────────────
  useEffect(() => {
    if (!landingPage) return;
    const lpId  = landingPage.id || landingPage._id;
    const fired = new Set();
    const track = (sec) => {
      if (fired.has(sec)) return;
      fired.add(sec);
      fetch("/api/landing/track-click", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ landingPageId: lpId, metadata: { type: "time", seconds: sec } }),
      }).catch(() => {});
    };
    const t1  = setTimeout(() => track(30),  30000);
    const t2  = setTimeout(() => track(60),  60000);
    const t3  = setTimeout(() => track(120), 120000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [landingPage]);

  // ── Buy Now ────────────────────────────────────────────────────────────────
  const handleBuyNow = () => {
    if (buying || !product) return;
    trackClarity("cta_buy_now", product._id || product.id);
    setBuying(true);
    const buyNow = [{
      productId:    product._id || product.id,
      title:        product.title,
      price:        product.salePrice || product.regularPrice,
      quantity:     1,
      image:        imgSrc((product.images || [])[0]),
      allowDeposit: product.allowDeposit ?? true,
    }];
    try { localStorage.setItem("buyNow", JSON.stringify(buyNow)); } catch {}

    // Track CTA click on landing page
    if (landingPage) {
      const lpId = landingPage.id || landingPage._id;
      const affiliate = (() => { try { return localStorage.getItem("affiliateId"); } catch { return null; } })();
      fetch("/api/landing/track-click", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ landingPageId: lpId, affiliateId: affiliate }),
      }).catch(() => {});
    }

    router.push("/checkout/address");
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  // Client fallback fetch still running — blank, no skeleton
  if (loading) return null;

  // Not found
  if (notFound || (!landingPage && !product)) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4" dir={dir} lang={lang} data-market-scope={lang}>
        <div className="text-center">
          <p className="text-5xl mb-4">🔍</p>
          <h1 className="text-xl font-bold text-gray-900 mb-2">{t("offer_not_found_title")}</h1>
          <p className="text-gray-500 text-sm mb-6">{t("offer_not_found_text")}</p>
          <Link href="/"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-400 text-white rounded-2xl font-semibold text-sm hover:bg-amber-500 transition-colors">
            <Home className="w-4 h-4" /> {t("offer_back_home")}
          </Link>
        </div>
      </div>
    );
  }

  // ── Derived values ─────────────────────────────────────────────────────────
  const sections      = Array.isArray(landingPage?.sections) ? landingPage.sections : [];

  // ── Sticky CTA: content + action derived from existing blocks ───────────────
  // Content reuses the CTA Button block's own config (no hardcoded text); the
  // sticky bar only renders when such a block exists. Action priority mirrors
  // the page's own logic: an existing COD order form wins (scroll to it), else
  // a configured custom URL redirects, else the existing Buy Now handler runs.
  const ctaBlock     = sections.find((b) => b.type === "cta" && b.visible !== false);
  const hasOrderForm = sections.some((b) => b.type === "orderForm" && b.visible !== false);

  // Scroll to the on-page order form, then focus its first input + play the
  // highlight (via the bumped ctaFocus signal). Returns false if no form exists.
  const scrollToOrderForm = () => {
    if (typeof document === "undefined") return false;
    const el = document.getElementById("lp-order-form");
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => setCtaFocus((n) => n + 1), 450); // after the scroll settles
    return true;
  };

  // SINGLE source of truth for EVERY CTA surface (all in-page CTA blocks AND the
  // sticky bar). An empty Custom URL + an order form → scroll+focus+highlight; a
  // Custom URL → redirect; otherwise the Buy Now (checkout) flow. Every CTA block
  // gets its own React onClick bound to this, so multiple instances all work.
  const handleCta = (buttonUrl) => {
    switch (resolveCtaAction({ hasOrderForm, buttonUrl })) {
      case 'scroll':   scrollToOrderForm(); break;
      case 'redirect': window.location.href = buttonUrl; break;
      default:         handleBuyNow();
    }
  };
  const handleStickyCTA = () => handleCta(ctaBlock?.config?.buttonUrl);

  // ════════════════════════════════════════════════════════════════════════════
  //  Empty by default — only renders what Builder explicitly added
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-gray-50 pb-28" dir={dir} lang={lang} data-market-scope={lang}>
      {/* Mobile-first locked layout — max 480 px centred on all screens */}
      <div className="max-w-[480px] mx-auto w-full">
        {sections.map((block) => (
          <BlockRenderer
            key={block.id}
            block={block}
            product={product}
            landingPage={landingPage}
            onBuyNow={handleBuyNow}
            onCta={handleCta}
            hasOrderForm={hasOrderForm}
            ctaFocus={ctaFocus}
            buying={buying}
          />
        ))}
      </div>

      {/* Activity popup overlay — intentionally outside the max-width container */}
      {(() => {
        const popupBlock = sections.find((b) => b.type === "activityPopup" && b.visible !== false);
        return popupBlock ? <ActivityPopup cfg={popupBlock.config || {}} product={product} /> : null;
      })()}

      {/* Sticky CTA — config-driven, COD-form aware; reuses existing handlers.
          Only renders when the page has a CTA Button block. */}
      {ctaBlock && (
        <StickyCTA
          cfg={ctaBlock.config || {}}
          onOrder={handleStickyCTA}
          buying={buying}
          hideWhenInViewId={hasOrderForm ? "lp-order-form" : undefined}
        />
      )}
    </div>
  );
}

// OfferContent is the default export — consumed by the Server Component page.jsx
export default OfferContent;
