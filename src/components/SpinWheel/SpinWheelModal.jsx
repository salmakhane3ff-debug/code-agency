"use client";

import { useState, useRef, useEffect } from "react";
import { X, Copy, Check, ShoppingCart } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

// ── Confetti ──────────────────────────────────────────────────────────────────
const CONFETTI_COLORS = [
  "#ef4444","#f97316","#f59e0b","#84cc16","#10b981",
  "#6366f1","#8b5cf6","#ec4899","#06b6d4",
];

function Confetti() {
  const pieces = Array.from({ length: 56 }, (_, i) => ({
    id: i,
    left:     `${Math.random() * 100}%`,
    color:    CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    delay:    `${(Math.random() * 0.7).toFixed(2)}s`,
    duration: `${(1.2 + Math.random() * 1.3).toFixed(2)}s`,
    size:     `${6 + Math.floor(Math.random() * 8)}px`,
    round:    Math.random() > 0.5,
  }));

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl z-10">
      {pieces.map((p) => (
        <div
          key={p.id}
          className="absolute top-0"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            background: p.color,
            borderRadius: p.round ? "50%" : "2px",
            animation: `confettiFall ${p.duration} ${p.delay} ease-in forwards`,
          }}
        />
      ))}
      <style>{`
        @keyframes confettiFall {
          0%   { opacity: 1; transform: translateY(-10px) rotate(0deg); }
          80%  { opacity: 1; }
          100% { opacity: 0; transform: translateY(420px) rotate(720deg); }
        }
      `}</style>
    </div>
  );
}

// ── SVG Wheel ─────────────────────────────────────────────────────────────────
function Wheel({ segments, rotation }) {
  const size  = 300;
  const cx    = size / 2;
  const cy    = size / 2;
  const r     = size / 2 - 6;
  const total = segments.reduce((s, seg) => s + (Number(seg.probability) || 1), 0);

  const paths = [];
  let angle   = -Math.PI / 2;

  segments.forEach((seg, i) => {
    const slice    = (Number(seg.probability) / total) * 2 * Math.PI;
    const endAngle = angle + slice;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const large = slice > Math.PI ? 1 : 0;

    const midAngle = angle + slice / 2;
    const imgR     = r * 0.56;
    const lx       = cx + imgR * Math.cos(midAngle);
    const ly       = cy + imgR * Math.sin(midAngle);

    // Scale image to segment arc width — min 36px, max 76px
    const rawSize = (slice / (2 * Math.PI)) * r * 2.8;
    const imgSize = Math.min(76, Math.max(36, rawSize));
    const half    = imgSize / 2;
    const clipId  = `seg-clip-${i}`;

    paths.push(
      <g key={i}>
        {/* Segment fill */}
        <path
          d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`}
          fill={seg.color || "#6366f1"}
          stroke="white"
          strokeWidth="2"
        />

        {/* Circular clip for image */}
        <defs>
          <clipPath id={clipId}>
            <circle cx={lx} cy={ly} r={half} />
          </clipPath>
        </defs>

        {seg.image ? (
          <>
            {/* White ring behind image */}
            <circle cx={lx} cy={ly} r={half + 2} fill="white" opacity="0.35" />
            <image
              href={seg.image}
              x={lx - half}
              y={ly - half}
              width={imgSize}
              height={imgSize}
              clipPath={`url(#${clipId})`}
              preserveAspectRatio="xMidYMid slice"
              style={{ pointerEvents: "none" }}
            />
            {/* Small label below image */}
            {seg.label && (
              <text
                x={lx}
                y={ly + half + 9}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="white"
                fontSize={8}
                fontWeight="700"
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {seg.label.slice(0, 10)}
              </text>
            )}
          </>
        ) : (
          <text
            x={lx} y={ly}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="white"
            fontSize={10}
            fontWeight="700"
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            {seg.label?.slice(0, 13)}
          </text>
        )}
      </g>
    );

    angle = endAngle;
  });

  return (
    <div
      className="relative"
      style={{
        width: size, height: size,
        transform:  `rotate(${rotation}deg)`,
        transition: "transform 4s cubic-bezier(0.17,0.67,0.12,0.99)",
        willChange: "transform",
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Outer decorative ring */}
        <circle cx={cx} cy={cy} r={r + 5} fill="#1e293b" />
        {paths}
        {/* Center cap */}
        <circle cx={cx} cy={cy} r={22} fill="white" stroke="#e2e8f0" strokeWidth="3" />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle"
          fill="#1e293b" fontSize="9" fontWeight="800">SPIN</text>
      </svg>
    </div>
  );
}

// ── Product Win Popup ─────────────────────────────────────────────────────────
function ProductWinPopup({ winner, cartTotal, onAddToCart, onStartShopping, onClose, t, formatPrice }) {
  const [product, setProduct] = useState(null);
  const [adding,  setAdding]  = useState(false);
  const [prizeLocked, setPrizeLocked] = useState(false); // admin product lock (API 403)

  const minVal    = Number(winner.minCartValue) || 0;
  const canUnlock = !minVal || cartTotal >= minVal;
  const remaining = Math.max(0, minVal - cartTotal);
  const pct       = minVal ? Math.min(100, Math.round((cartTotal / minVal) * 100)) : 100;

  useEffect(() => {
    if (!winner.productId) return;
    fetch(`/api/products/${winner.productId}`)
      .then((r) => { if (r.status === 403) setPrizeLocked(true); return r.json(); })
      .then((d) => { if (d?._id) setProduct(d); })
      .catch(() => {});
  }, [winner.productId]);

  const imgSrc =
    product?.images?.[0]?.url ||
    product?.images?.[0]       ||
    winner.image               ||
    null;

  const handleAdd = async () => {
    if (adding) return;
    if (prizeLocked) { alert(t("product_locked_cart")); return; }
    setAdding(true);
    await onAddToCart(product);
    setAdding(false);
  };

  return (
    <div className="p-5 text-center space-y-4 relative">
      <Confetti />

      {/* Product image — large and clear */}
      <div className="relative mx-auto" style={{ width: 148, height: 148 }}>
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={product?.title || winner.label}
            className="w-full h-full object-cover rounded-2xl shadow-lg border-4"
            style={{ borderColor: winner.color || "#6366f1" }}
          />
        ) : (
          <div
            className="w-full h-full rounded-2xl flex items-center justify-center text-6xl shadow-lg border-4"
            style={{ background: `${winner.color || "#6366f1"}22`, borderColor: winner.color || "#6366f1" }}
          >
            🎁
          </div>
        )}
        {/* Badge */}
        <div className="absolute -top-2 -right-2 w-9 h-9 bg-yellow-400 rounded-full flex items-center justify-center text-xl shadow-md">
          🎉
        </div>
      </div>

      {/* Title */}
      <div>
        <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wider mb-1">
          {t("spin_win_congrats")}
        </p>
        <h3 className="text-lg font-bold text-gray-900 leading-tight">
          {product?.title || winner.label}
        </h3>
        <p className="text-sm text-gray-500 mt-0.5">{t("spin_win_you_won")}</p>
      </div>

      {/* Cart value gate */}
      {minVal > 0 && !canUnlock && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-left space-y-2">
          <p className="text-xs text-amber-700 font-semibold">
            {t("spin_win_need_more").replace("{amount}", formatPrice(remaining.toFixed(0)))}
          </p>
          <div className="w-full h-2 bg-amber-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-400 rounded-full transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-amber-600">
            <span>{formatPrice(cartTotal.toFixed(0))}</span>
            <span>{formatPrice(minVal)}</span>
          </div>
        </div>
      )}

      {/* CTA */}
      {canUnlock ? (
        <button
          onClick={handleAdd}
          disabled={adding}
          className="w-full py-3.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold
            rounded-2xl text-base disabled:opacity-60 hover:from-indigo-700 hover:to-purple-700
            active:scale-95 transition-all shadow-lg shadow-indigo-200 flex items-center justify-center gap-2"
        >
          <ShoppingCart className="w-5 h-5" />
          {adding ? "…" : t("spin_win_add_to_cart")}
        </button>
      ) : (
        <button
          onClick={onStartShopping}
          className="w-full py-3.5 bg-amber-500 text-white font-bold rounded-2xl text-base
            hover:bg-amber-600 active:scale-95 transition-all shadow-lg"
        >
          {t("spin_win_start_shopping")}
        </button>
      )}

      <button
        onClick={onClose}
        className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
      >
        {t("spin_win_close")}
      </button>
    </div>
  );
}

// ── Main modal ─────────────────────────────────────────────────────────────────
export default function SpinWheelModal({ config, sessionId, onClose, onWin }) {
  const { t, dir, formatPrice } = useLanguage();

  const [phase,     setPhase]     = useState("idle"); // idle | spinning | result
  const [winner,    setWinner]    = useState(null);
  const [rotation,  setRotation]  = useState(0);
  const [copied,    setCopied]    = useState(false);
  const [cartTotal, setCartTotal] = useState(0);
  const rotRef = useRef(0);

  const { segments = [], title, subtitle } = config || {};
  const displayTitle    = title    || t("spin_title");
  const displaySubtitle = subtitle || t("spin_subtitle");

  // Keep cart total fresh for minCartValue gating
  useEffect(() => {
    const read = () => {
      try {
        const cart  = JSON.parse(localStorage.getItem("cart") || "[]");
        const total = cart.reduce((s, i) => s + (Number(i.price) * Number(i.quantity)), 0);
        setCartTotal(total);
      } catch {}
    };
    read();
    window.addEventListener("cartUpdated", read);
    return () => window.removeEventListener("cartUpdated", read);
  }, []);

  const spin = async () => {
    if (phase !== "idle" || !segments.length) return;
    setPhase("spinning");

    // Track click
    fetch("/api/spin-wheel-spin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, eventType: "spin_click" }),
    }).catch(() => {});

    try {
      const res  = await fetch("/api/spin-wheel-spin", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sessionId, clickId: sessionStorage.getItem("clickId") }),
      });
      const data = await res.json();

      const total      = segments.reduce((s, seg) => s + (Number(seg.probability) || 1), 0);
      let cumulative   = 0;
      for (let i = 0; i < data.index; i++) {
        cumulative += (Number(segments[i].probability) / total) * 360;
      }
      const segSize        = (Number(segments[data.index]?.probability || 10) / total) * 360;
      const centerOfWinner = cumulative + segSize / 2;
      const targetOffset   = 360 - centerOfWinner;
      const finalAngle     = rotRef.current + 5 * 360 + targetOffset;

      rotRef.current = finalAngle % 360;
      setRotation(finalAngle);
      setWinner(data);
      setTimeout(() => setPhase("result"), 4200);
    } catch {
      setPhase("idle");
    }
  };

  const copyCode = () => {
    if (!winner?.couponCode) return;
    navigator.clipboard.writeText(winner.couponCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
    fetch("/api/spin-wheel-spin", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sessionId, eventType: "coupon_used", couponCode: winner.couponCode }),
    }).catch(() => {});
    onWin?.(winner);
  };

  // Direct add-to-cart for product rewards (no minCartValue or threshold already met)
  const handleAddToCart = async (product) => {
    const pid   = product?._id || winner?.productId;
    const cart  = JSON.parse(localStorage.getItem("cart") || "[]");
    const alreadyFree = cart.find((i) => i.productId === pid && i.free);
    if (!alreadyFree) {
      cart.push({
        productId: pid,
        title:     product?.title || winner?.label || "",
        quantity:  1,
        price:     0,
        free:      true,
        image:     product?.images?.[0]?.url || product?.images?.[0] || winner?.image || "",
      });
      localStorage.setItem("cart", JSON.stringify(cart));
      window.dispatchEvent(new Event("cartUpdated"));
    }
    // Track
    fetch("/api/spin-wheel-spin", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sessionId, eventType: "reward_unlock", productId: pid }),
    }).catch(() => {});
    onWin?.(winner);
    onClose();
  };

  // minCartValue not yet met → save reward, close, show progress banner
  const handleStartShopping = () => {
    onWin?.(winner);
    onClose();
  };

  return (
    /* z-[10010] — above cart drawer (HeroUI default ~50) and sidebar */
    <div
      className="fixed inset-0 z-[10010] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
      dir={dir}
    >
      <div
        className="relative bg-white rounded-3xl shadow-2xl max-w-sm w-full overflow-hidden"
        style={{ animation: "swFadeIn 0.35s cubic-bezier(0.34,1.56,0.64,1)" }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-20 w-8 h-8 rounded-full bg-white/80
            backdrop-blur-sm flex items-center justify-center hover:bg-white
            transition-colors shadow-sm"
        >
          <X className="w-4 h-4 text-gray-600" />
        </button>

        {/* Header gradient */}
        <div className="bg-gradient-to-br from-indigo-600 to-purple-600 px-6 pt-6 pb-4 text-center">
          <div className="text-2xl mb-1">🎰</div>
          <h2 className="text-xl font-bold text-white">{displayTitle}</h2>
          {displaySubtitle && (
            <p className="text-indigo-200 text-sm mt-0.5">{displaySubtitle}</p>
          )}
        </div>

        {/* ── Wheel phase ── */}
        {phase !== "result" && (
          <div className="p-6 flex flex-col items-center gap-4">
            <div className="relative">
              {/* Pointer arrow */}
              <div
                className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 z-10"
                style={{
                  width: 0, height: 0,
                  borderLeft:  "10px solid transparent",
                  borderRight: "10px solid transparent",
                  borderTop:   "20px solid #1e293b",
                }}
              />
              <Wheel segments={segments} rotation={rotation} />
            </div>

            <button
              onClick={spin}
              disabled={phase === "spinning"}
              className="w-full py-3.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white
                font-bold rounded-2xl text-base disabled:opacity-60 disabled:cursor-not-allowed
                hover:from-indigo-700 hover:to-purple-700 active:scale-95
                transition-all shadow-lg shadow-indigo-200"
            >
              {phase === "spinning" ? t("spin_button_spinning") : t("spin_button_idle")}
            </button>
            <p className="text-xs text-gray-400">{t("spin_once_per_session")}</p>
          </div>
        )}

        {/* ── Result phase ── */}
        {phase === "result" && winner && (
          <>
            {/* No reward */}
            {winner.rewardType === "none" && (
              <div className="p-6 text-center space-y-4">
                <div className="text-6xl">😔</div>
                <h3 className="text-xl font-bold text-gray-900">{t("spin_win_better_luck")}</h3>
                <p className="text-gray-500 text-sm">{winner.label}</p>
                <button
                  onClick={onClose}
                  className="w-full py-3 border border-gray-200 rounded-2xl text-sm font-medium
                    text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  {t("spin_win_close")}
                </button>
              </div>
            )}

            {/* Coupon reward */}
            {winner.rewardType === "coupon" && (
              <div className="p-6 text-center space-y-4 relative">
                <Confetti />
                <div className="text-6xl">🎉</div>
                <h3 className="text-xl font-bold text-gray-900">{t("spin_win_congrats")}</h3>
                <p className="text-gray-600 text-sm">{winner.label}</p>
                {winner.couponCode && (
                  <div className="bg-indigo-50 border-2 border-dashed border-indigo-200 rounded-2xl px-4 py-3">
                    <p className="text-xs text-indigo-400 mb-1">{t("spin_win_coupon_code")}</p>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-lg font-bold text-indigo-700">
                        {winner.couponCode}
                      </span>
                      <button
                        onClick={copyCode}
                        className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white
                          text-xs rounded-lg hover:bg-indigo-700 transition-colors"
                      >
                        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {copied ? t("spin_win_copied") : t("spin_win_copy")}
                      </button>
                    </div>
                  </div>
                )}
                <button
                  onClick={onClose}
                  className="w-full py-3 bg-indigo-600 text-white font-bold rounded-2xl
                    hover:bg-indigo-700 transition-colors"
                >
                  {t("spin_win_shop_now")}
                </button>
              </div>
            )}

            {/* Free shipping reward */}
            {winner.rewardType === "free_shipping" && (
              <div className="p-6 text-center space-y-4 relative">
                <Confetti />
                <div className="text-6xl">🚚</div>
                <h3 className="text-xl font-bold text-gray-900">{t("spin_win_free_shipping")}</h3>
                <p className="text-gray-600 text-sm">{t("spin_win_free_shipping_msg")}</p>
                <button
                  onClick={() => { onWin?.(winner); onClose(); }}
                  className="w-full py-3 bg-green-600 text-white font-bold rounded-2xl
                    hover:bg-green-700 transition-colors"
                >
                  {t("spin_win_shop_now")}
                </button>
              </div>
            )}

            {/* Product reward — full popup with image + Add to Cart */}
            {winner.rewardType === "product" && (
              <ProductWinPopup
                winner={winner}
                cartTotal={cartTotal}
                onAddToCart={handleAddToCart}
                onStartShopping={handleStartShopping}
                onClose={onClose}
                t={t}
                formatPrice={formatPrice}
              />
            )}
          </>
        )}
      </div>

      <style>{`
        @keyframes swFadeIn {
          from { opacity: 0; transform: scale(0.78); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
