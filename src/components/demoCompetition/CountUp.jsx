"use client";
/**
 * CountUp — requestAnimationFrame tween from the previous value to the new one
 * (skipped when the visitor prefers reduced motion). Money — a demo amount in
 * centimes shown as "<number> DH" / "<number> درهم", the number being an LTR island.
 */
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { currencyUnit, formatAmount, formatCount } from "@/lib/demoCompetition/i18n";

export function CountUp({ value, format, durationMs = 900 }) {
  const reduce = useReducedMotion();
  const target = Math.round(Number(value) || 0);
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return undefined;
    if (reduce || typeof requestAnimationFrame !== "function") {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }
    let raf = 0;
    let t0 = null;
    const step = (now) => {
      if (t0 === null) t0 = now;
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - (1 - p) ** 3;
      const v = Math.round(from + (target - from) * eased);
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduce, durationMs]);

  return format ? format(shown) : String(shown);
}

export function Money({ cents, lang, animate = false, prefix = "", className = "" }) {
  return (
    <span className={`whitespace-nowrap ${className}`}>
      <bdi dir="ltr" className="tabular-nums">
        {prefix}
        {animate ? <CountUp value={cents} format={(c) => formatAmount(c, lang)} /> : formatAmount(cents, lang)}
      </bdi>
      {" "}
      <span className="text-[0.8em] font-semibold opacity-80">{currencyUnit(lang)}</span>
    </span>
  );
}

export function Count({ value, lang, className = "" }) {
  return <bdi dir="ltr" className={`tabular-nums ${className}`}>{formatCount(value, lang)}</bdi>;
}
