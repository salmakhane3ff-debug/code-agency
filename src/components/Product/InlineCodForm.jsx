"use client";

/**
 * src/components/Product/InlineCodForm.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The inline COD order form — the SAME UX used by landing pages, now shared so
 * the product page can embed it too (no duplicated form / order logic). It posts
 * to the existing /api/order pipeline via the pure buildCodOrderPayload, and
 * fires the existing affiliate-recording call. Optional props let the product
 * page pass the selected quantity / variants / price and mark orderSource.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useRef, useEffect } from "react";
import { Zap } from "lucide-react";
import { resolveClickId } from "@/lib/tracking/clickId";
import { buildCodOrderPayload, validateCodForm } from "@/lib/codOrder";
import { trackPurchase } from "@/lib/meta/purchase";
import { fieldDir } from "@/lib/marketLocale";

// The form's built-in texts (Arabic — the original wording). A caller may override any of them.
const DEFAULT_TEXT = Object.freeze({
  successTitle: "تم استلام طلبك بنجاح!",
  successSub: "سنتصل بك قريباً لتأكيد الطلب.",
  heading: "أكمل طلبك الآن",
  name: "الاسم الكامل *",
  phone: "رقم الهاتف *",
  city: "المدينة",
  address: "العنوان التفصيلي",
  error: "حدث خطأ، يرجى المحاولة مرة أخرى.",
  sending: "جارٍ الإرسال…",
  submit: "اطلب الآن",
});

function imgSrc(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  return v.url || v.src || "";
}

export default function InlineCodForm({
  product,
  cfg = {},
  landingPage = null,
  quantity = 1,
  variant = null,
  price = null,
  orderSource = "landing",
  // Bump this counter (from the product page's Buy Now) to focus the first field
  // and play a subtle highlight so the customer immediately notices the form.
  focusSignal = 0,
  // Optional texts / direction for a market-localized caller (the /offer landing page passes the
  // visitor's market — MA Arabic RTL / FR French LTR). Without them the form renders exactly as
  // before (Arabic, RTL), so the product page is unchanged.
  text = null,
  dir = "rtl",
  phoneDir = undefined,
}) {
  const tx = { ...DEFAULT_TEXT, ...(text || {}) };
  const [form,   setForm]   = useState({ name: "", phone: "", city: "", address: "" });
  const [status, setStatus] = useState("idle"); // idle | submitting | success | error
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const nameRef = useRef(null);
  const cardRef = useRef(null);

  useEffect(() => {
    if (!focusSignal) return; // landing usage never signals → no focus/animation
    nameRef.current?.focus({ preventScroll: true });
    const card = cardRef.current;
    if (card) {
      // Restart the CSS animation without remounting (which would reset inputs).
      card.style.animation = "none";
      void card.offsetWidth; // force reflow
      card.style.animation = "codAttn 1.3s ease-out";
    }
  }, [focusSignal]);

  const submit = async (e) => {
    e.preventDefault();
    if (!validateCodForm(form).valid) return;
    setStatus("submitting");
    try {
      const prefix    = orderSource === "product" ? "pp" : "lp";
      const sessionId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Reuse the same attribution/tracking the working checkout relies on.
      const affiliateId  = (() => { try { return localStorage.getItem("affiliateId")  || null; } catch { return null; } })();
      const affiliateRef = (() => { try { return localStorage.getItem("affiliateRef") || null; } catch { return null; } })();
      const images = (product?.images || []).map(imgSrc).filter(Boolean);

      const payload = buildCodOrderPayload({
        product, form, quantity, variant, price, orderSource, landingPage,
        sessionId, bemobClickId: resolveClickId(), affiliateId, images,
      });

      const res = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        // Affiliate recording — identical fire-and-forget flow as landing/checkout.
        try {
          const created = await res.json();
          const orderId = created?._id || created?.id || null;

          // Meta Purchase. This form never reaches /checkout/success, which is
          // why inline-COD and landing/offer orders previously reported nothing
          // at all. It goes through the SAME shared pipeline as the success
          // page — never a copy — and only after the order really exists.
          if (orderId) {
            trackPurchase({
              _id:           orderId,
              status:        created?.status,
              paymentStatus: created?.paymentStatus,
              paymentMethod: payload?.paymentDetails?.paymentMethod,
              total:         payload?.paymentDetails?.total,
              items:         payload?.products?.items || [],
            });
          }

          if (affiliateRef || affiliateId) {
            fetch("/api/affiliate/record-order", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                username: affiliateRef, affiliateId, orderId,
                clientName: form.name.trim(), clientPhone: form.phone.trim() || "",
                productTitle: product?.title || "", total: payload.paymentDetails.total,
              }),
            }).catch(() => {});
          }
        } catch {}
        setStatus("success");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  if (status === "success") {
    return (
      <div className="px-4 py-3">
        <div className="bg-green-50 border border-green-200 rounded-2xl p-6 text-center space-y-3">
          <div className="text-4xl">🎉</div>
          <p className="text-base font-black text-green-700">
            {cfg.successMessage || tx.successTitle}
          </p>
          <p className="text-sm text-green-600">{tx.successSub}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <style>{`@keyframes codAttn {
        0%   { box-shadow: 0 0 0 0 rgba(251,191,36,0); }
        20%  { box-shadow: 0 0 0 4px rgba(251,191,36,0.55); }
        100% { box-shadow: 0 0 0 0 rgba(251,191,36,0); }
      }`}</style>
      <div ref={cardRef} className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
        <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4">📦 {tx.heading}</p>
        <form onSubmit={submit} className="space-y-3" dir={dir}>
          <input ref={nameRef} required value={form.name} onChange={(e) => setF("name", e.target.value)}
            placeholder={tx.name}
            className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-200 bg-gray-50" />
          <input required type="tel" value={form.phone} onChange={(e) => setF("phone", e.target.value)}
            placeholder={tx.phone} dir={phoneDir === "auto" ? fieldDir(form.phone) : phoneDir}
            className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-200 bg-gray-50" />
          <input value={form.city} onChange={(e) => setF("city", e.target.value)}
            placeholder={tx.city}
            className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-200 bg-gray-50" />
          {cfg.showAddress !== false && (
            <input value={form.address} onChange={(e) => setF("address", e.target.value)}
              placeholder={tx.address}
              className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-200 bg-gray-50" />
          )}
          {status === "error" && (
            <p className="text-xs text-red-500 text-center">{tx.error}</p>
          )}
          <button type="submit" disabled={status === "submitting"}
            className="w-full flex items-center justify-center gap-2 py-4 bg-amber-400 hover:bg-amber-500 active:scale-[0.98] text-white rounded-2xl font-black text-base transition-all shadow-lg shadow-amber-200 disabled:opacity-70">
            <Zap className="w-5 h-5" />
            {status === "submitting" ? tx.sending : (cfg.buttonText || tx.submit)}
          </button>
        </form>
      </div>
    </div>
  );
}
