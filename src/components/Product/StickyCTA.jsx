"use client";

/**
 * src/components/Product/StickyCTA.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Mobile-only sticky bottom CTA bar for landing pages.
 *
 * Purely presentational + behavioral wrapper — it owns NO order/checkout/COD
 * logic. The page resolves the action (scroll to COD form / redirect / Buy Now)
 * and passes it in as `onOrder`; all visible text and colors come from the
 * page's existing CTA Button block config (nothing is hardcoded here).
 *
 * Visibility: hidden at the top of the page, slides up after the visitor has
 * scrolled ~35% of the page, hides again near the top. Slide-up and the subtle
 * periodic button pulse are both disabled under prefers-reduced-motion.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";

// Show once the visitor has scrolled at least this fraction of the page.
const SCROLL_THRESHOLD = 0.35;

export default function StickyCTA({ cfg = {}, onOrder, buying = false, hideWhenInViewId }) {
  const [visible, setVisible] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [formInView, setFormInView] = useState(false);

  // Respect prefers-reduced-motion.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  // Scroll visibility: show past the scroll-depth threshold, hide near the top.
  useEffect(() => {
    let ticking = false;
    const evaluate = () => {
      ticking = false;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const pct = max > 0 ? window.scrollY / max : 0;
      setVisible(pct >= SCROLL_THRESHOLD);
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(evaluate);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    evaluate();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Hide the bar while the COD order form is in view, so it never covers the
  // form's submit button. Only active when the page provides a form anchor id
  // (i.e. an order form exists); otherwise behavior is unchanged.
  useEffect(() => {
    if (!hideWhenInViewId || typeof IntersectionObserver === "undefined") return;
    const el = document.getElementById(hideWhenInViewId);
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setFormInView(entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hideWhenInViewId]);

  // Final visibility: scrolled-in AND not currently over the order form.
  const show = visible && !formInView;

  // Subtle pulse every 8–12s (skipped under reduced motion / when hidden).
  useEffect(() => {
    if (reducedMotion || !show) return;
    let timeoutId;
    let releaseId;
    const schedule = () => {
      const delay = 8000 + Math.random() * 4000; // 8–12s
      timeoutId = setTimeout(() => {
        setPulse(true);
        releaseId = setTimeout(() => setPulse(false), 400);
        schedule();
      }, delay);
    };
    schedule();
    return () => { clearTimeout(timeoutId); clearTimeout(releaseId); };
  }, [reducedMotion, show]);

  // All visible text/colors come from the page's CTA block config.
  const headingText = cfg.text;
  const buttonText = cfg.buttonText;
  const buttonColor = cfg.buttonColor || "#f59e0b";
  const barBg = cfg.bgColor || "#ffffff";

  const barCls = `md:hidden fixed bottom-0 left-0 right-0 z-50 will-change-transform ${reducedMotion ? "" : "transition-transform duration-300 ease-out"} ${show ? "translate-y-0" : "translate-y-full"}`;
  const innerCls = "rounded-t-2xl border-t border-gray-100 shadow-[0_-4px_28px_rgba(0,0,0,0.13)] px-4 py-3 flex items-center gap-3 min-h-[64px]";
  const buttonCls = "shrink-0 flex items-center gap-1.5 px-6 py-3 rounded-xl text-white font-black text-base whitespace-nowrap shadow-md disabled:opacity-70";

  return (
    <div role="complementary" aria-label={buttonText || "CTA"} className={barCls}>
      {/* Direction is inherited from the landing page (market: RTL for MA, LTR for FR). */}
      <div className={innerCls} style={{ background: barBg }}>
        {headingText && (
          <p className="flex-1 min-w-0 text-sm font-black text-gray-900 leading-snug line-clamp-2">
            {headingText}
          </p>
        )}
        <button
          type="button"
          onClick={onOrder}
          disabled={buying}
          className={buttonCls}
          style={{
            background: buttonColor,
            transform: pulse ? "scale(1.05)" : "scale(1)",
            transition: reducedMotion ? "none" : "transform 0.4s ease",
          }}
        >
          <Zap className="w-4 h-4" />
          {buying ? "..." : buttonText}
        </button>
      </div>
    </div>
  );
}
