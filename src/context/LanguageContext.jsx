"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import ar from "@/locales/ar.json";
import fr from "@/locales/fr.json";
import {
  LANGUAGE_SETTINGS_TYPE, FALLBACK_LANG, LANG_STORAGE_KEY,
  normalizeLang, readDefaultLang,
} from "@/lib/languageSettings";
import { htmlDirFor } from "@/lib/marketLocale";

const translations = { ar, fr };

// Re-exported names kept local so the rest of this file reads unchanged.
const DEFAULT_LANG = FALLBACK_LANG;
const STORAGE_KEY = LANG_STORAGE_KEY;

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  /**
   * Lazy initializer — runs once per render environment:
   *   Server: window is undefined → return DEFAULT_LANG (matches the HTML shell)
   *   Client: the blocking inline script in <head> has already written data-lang
   *           onto <html>, so we read the correct language synchronously here.
   *           This means the very first client render already uses "fr" (or "ar"),
   *           so React never commits a wrong-language frame to the DOM.
   */
  // Always start with DEFAULT_LANG so the first client render matches the server HTML.
  // After hydration completes, useEffect reads the stored preference and updates.
  const [lang, setLangState] = useState(DEFAULT_LANG);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // The blocking <head> script only stamps data-lang when this browser HAS a
    // stored preference, so this branch means "the visitor already chose".
    const fromDom = normalizeLang(document.documentElement.getAttribute("data-lang"));
    if (fromDom) {
      setLangState(fromDom);
      setMounted(true);
      return;
    }

    try {
      const saved = normalizeLang(localStorage.getItem(STORAGE_KEY));
      if (saved) {
        setLangState(saved);
        setMounted(true);
        return;
      }
    } catch {}

    // No stored visitor preference — use the admin-configured store default.
    fetch(`/api/setting?type=${LANGUAGE_SETTINGS_TYPE}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const storeDefault = readDefaultLang(data);
        if (storeDefault) setLangState(storeDefault);
      })
      .catch(() => {})
      .finally(() => setMounted(true));
  }, []);

  // Sync HTML attributes and persist whenever lang changes.
  // IMPORTANT: Never apply RTL on admin pages — a management interface that must
  // always be LTR. Every other route follows the language; the market-scoped
  // areas (affiliate, recruiter, landing pages) follow it too: MA → Arabic/RTL,
  // FR → French/LTR (see src/lib/marketLocale.js — htmlDirFor is the one rule).
  // window.location.pathname is read at effect time (always current route).
  useEffect(() => {
    if (!mounted) return;
    const dir = htmlDirFor(window.location.pathname, lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    document.documentElement.setAttribute("data-lang", lang);
    // NOT persisted here. This effect also runs for a language DERIVED from the
    // store default (or from the fallback when the fetch fails), and writing
    // that to localStorage would pin a visitor who never chose anything — after
    // which a later change to the store default could never reach them.
    // Only setLang(), an explicit visitor action, writes the preference.
  }, [lang, mounted]);

  /**
   * An EXPLICIT visitor choice — the only thing that writes the per-browser
   * preference. Once written it outranks the store default for good, which is
   * what "existing visitors keep their stored preference" means.
   */
  const setLang = useCallback((newLang) => {
    const code = normalizeLang(newLang);
    if (!code) return;
    setLangState(code);
    try { localStorage.setItem(STORAGE_KEY, code); } catch {}
  }, []);

  /**
   * Translate a key. Falls back to the key itself if not found.
   * Usage: t("add_to_cart")  →  "أضف إلى السلة" (ar) or "Ajouter au panier" (fr)
   */
  const t = useCallback(
    (key) => translations[lang]?.[key] ?? translations[DEFAULT_LANG]?.[key] ?? key,
    [lang]
  );

  /**
   * Format a price in Moroccan Dirham.
   * Arabic → "120 درهم"   French → "120 DH"
   */
  const formatPrice = useCallback(
    (amount) => {
      const num = Number(amount) ?? 0;
      const formatted = Number.isInteger(num) ? num : num.toFixed(2);
      if (lang === "ar") return `${formatted} درهم`;
      return `${formatted} DH`;
    },
    [lang]
  );

  const dir = lang === "ar" ? "rtl" : "ltr";

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, dir, formatPrice, mounted }}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * Hook to access the language context.
 * Safe to call outside the provider — returns sensible Arabic defaults.
 */
export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    return {
      lang: DEFAULT_LANG,
      dir: "rtl",
      t: (key) => translations[DEFAULT_LANG]?.[key] ?? key,
      formatPrice: (amount) => `${Number(amount) ?? 0} درهم`,
      setLang: () => {},
      mounted: false,
    };
  }
  return ctx;
}
