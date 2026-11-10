"use client";
/**
 * src/context/useMarketLocale.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The one hook the market-scoped areas use to read the visitor's market. It is a
 * thin view over the EXISTING LanguageContext (same state, same `store_lang`
 * persistence, same LanguageSwitcher) — not a second localization system.
 *
 *   const { lang, dir, market, t, intlLocale } = useMarketLocale(MY_TEXT);
 *   MY_TEXT = { ar: {...}, fr: {...} }   // same shape as src/lib/brandI18n.js
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useLanguage } from "@/context/LanguageContext";
import LanguageSwitcher from "@/components/template/LanguageSwitcher";
import { makeMarketT, marketForLang, marketIntlLocale } from "@/lib/marketLocale";
import { FALLBACK_LANG } from "@/lib/languageSettings";

// Hydration-safe: the server always renders the fallback language (LanguageContext starts there), and the
// page content hydrates inside the root layout's Suspense boundary — possibly AFTER LanguageContext has
// already switched to the visitor's stored market. During hydration React reads the SERVER snapshot below
// (false), so the first client render matches the server HTML; right after, the client snapshot (true)
// re-renders in the visitor's market. Same approach as the store Header's `mounted` gate.
const noopSubscribe = () => () => {};
export const useHydrated = () => useSyncExternalStore(noopSubscribe, () => true, () => false);

// First paint: for a market-scoped route whose persisted market is not Arabic (or not chosen yet), the pre-paint
// <head> script (app/layout.jsx) sets <html data-market-pending> so CSS (globals.css) keeps the market content
// invisible instead of flashing the server's Arabic. It is lifted here once the content has re-rendered in the
// visitor's market (hydrated) and LanguageContext has resolved the language (mounted). A CSS fallback reveals the
// content after 3 s whatever happens, so a script failure can never leave a page blank.
const PENDING_ATTR = "data-market-pending";

export function useMarketLocale(dicts) {
  const { lang: contextLang, setLang } = useLanguage();
  const hydrated = useHydrated();
  const siteLang = hydrated ? contextLang : FALLBACK_LANG;
  return useMemo(() => {
    const m = marketForLang(siteLang);
    return {
      lang: m.lang,
      dir: m.dir,
      market: m.market,
      intlLocale: marketIntlLocale(m.lang),
      t: makeMarketT(dicts, m.lang),
      setLang,
    };
  }, [siteLang, dicts, setLang]);
}

/**
 * The site's EXISTING selector (src/components/template/LanguageSwitcher.jsx — same component, same `store_lang`),
 * remounted once after hydration. LanguageSwitcher marks the active flag with a class and carries
 * suppressHydrationWarning, so when its subtree hydrates after LanguageContext already switched to the stored
 * market, the server's "Arabic active" class would stay in the DOM. The key change re-creates it with the current
 * language. Used where the market areas render the selector themselves (the recruiter area has no store header).
 */
// The selector's own button labels, in the visitor's market (the storefront keeps its existing labels).
const SWITCHER_TEXT = Object.freeze({
  ar: Object.freeze({ ar: "التبديل إلى العربية", fr: "التبديل إلى الفرنسية" }),
  fr: Object.freeze({ ar: "Passer à l'arabe", fr: "Passer au français" }),
});

export function MarketLanguageSwitcher() {
  const hydrated = useHydrated();
  const { lang } = useMarketLocale(null);
  return <LanguageSwitcher key={hydrated ? "client" : "server"} labels={SWITCHER_TEXT[lang]} />;
}

/**
 * Lifts the first-paint gate. Called ONLY by the roots of market content (MarketScope, the landing pages' roots) —
 * never by chrome such as the store header — so the gate opens after the content itself has committed in the
 * visitor's market.
 */
export function useMarketPaintGate() {
  const { lang: contextLang, mounted } = useLanguage();
  const hydrated = useHydrated();
  useEffect(() => {
    if (hydrated && mounted) document.documentElement.removeAttribute(PENDING_ATTR);
  }, [hydrated, mounted, contextLang]);
}

/**
 * A subtree wrapper that renders in the market's language and direction. Used by
 * the market-scoped layouts in place of their old hard-coded `dir` / `lang`.
 */
export function MarketScope({ children, className, style, ...rest }) {
  const { lang, dir } = useMarketLocale(null);
  useMarketPaintGate();
  return (
    <div dir={dir} lang={lang} className={className} style={style} data-market-scope={lang} {...rest}>
      {children}
    </div>
  );
}
