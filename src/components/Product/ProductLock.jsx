"use client";

/**
 * Storefront pieces for a LOCKED product (see src/lib/productLock.js).
 *   <LockedOverlay />  — lock icon + label over the card image
 *   <LockableLink>     — the card's usual link (Next <Link>, or <a> with
 *                        `anchor`) for open products; for a locked
 *                        product a plain, non-navigating block (no href at all)
 * The server enforces the lock too (product page, product API, createOrder);
 * this only keeps the grid from offering a click that would lead nowhere.
 */
import Link from "next/link";
import { Lock } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

export function LockedOverlay() {
  const { t } = useLanguage();
  return (
    <div data-locked="true" className="absolute inset-0 flex items-center justify-center bg-black/25 pointer-events-none">
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-900/85 text-white text-xs font-bold px-2.5 py-1">
        <Lock className="w-3.5 h-3.5" aria-hidden="true" /> {t("product_locked")}
      </span>
    </div>
  );
}

/** `anchor` renders a plain <a> (for grids that used one) so open products behave exactly as before. */
export function LockableLink({ locked, href, anchor = false, children, ...rest }) {
  const { t } = useLanguage();
  if (locked) {
    return (
      <div aria-disabled="true" title={t("product_locked_message")} className="cursor-not-allowed">
        {children}
      </div>
    );
  }
  if (anchor) return <a href={href} {...rest}>{children}</a>;
  return <Link href={href} {...rest}>{children}</Link>;
}
