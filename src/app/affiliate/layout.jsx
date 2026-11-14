/**
 * src/app/affiliate/layout.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The Affiliate area follows the visitor's MARKET — the existing site-language
 * choice (🇲🇦 / 🇫🇷 LanguageSwitcher → `store_lang`): MA → Arabic, right-to-left;
 * FR → French, left-to-right. MarketScope stamps `dir` / `lang` on this subtree
 * from LanguageContext; <html dir> follows the same rule (pre-paint script in
 * app/layout.jsx + LanguageContext → src/lib/marketLocale.js htmlDirFor).
 * No functionality is changed.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { MarketScope } from "@/context/useMarketLocale";

// iOS reports the safe-area insets (home indicator, landscape notch) only with viewport-fit=cover: the
// dashboard's bottom nav / floating buttons pad themselves with env(safe-area-inset-*). Affiliate area only.
export const viewport = { viewportFit: "cover" };

export default function AffiliateLayout({ children }) {
  return <MarketScope>{children}</MarketScope>;
}
