"use client";

import { useLanguage } from "@/context/LanguageContext";

const LANGS = [
  { code: "ar", flag: "🇲🇦", label: "Switch to Arabic" },
  { code: "fr", flag: "🇫🇷", label: "Switch to French" },
];

// `labels` (optional, { ar, fr }): localized button labels for the market-scoped areas. Without it — every storefront
// usage — the existing labels below are used unchanged.
export default function LanguageSwitcher({ labels = null }) {
  const { lang, setLang } = useLanguage();

  return (
    <div className="flex items-center gap-1 select-none">
      {LANGS.map(({ code, flag, label }) => (
        <button
          key={code}
          onClick={() => setLang(code)}
          aria-label={labels?.[code] ?? label}
          title={labels?.[code] ?? label}
          suppressHydrationWarning
          className={`w-7 h-7 flex items-center justify-center rounded-md text-lg transition-all duration-150
            ${lang === code
              ? "ring-2 ring-orange-400 ring-offset-1 scale-110"
              : "opacity-50 hover:opacity-90 hover:scale-105"
            }`}
        >
          {flag}
        </button>
      ))}
    </div>
  );
}
