/**
 * src/lib/marketLocale.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Market-based language for the four market-scoped areas (Affiliate Dashboard,
 * Recruiter Dashboard, Landing Pages, recruitment landing) — pure, no React, no
 * DOM, no I/O, so it runs in the pre-paint <head> script's source of truth AND
 * in unit tests.
 *
 * There is NO new selector and NO new detection here. The market IS the visitor's
 * existing site-language choice (the 🇲🇦 / 🇫🇷 LanguageSwitcher → LanguageContext
 * → localStorage `store_lang`, or the admin-configured store default when the
 * visitor never chose):
 *
 *   MA (Morocco) ⇄ 'ar' → Arabic, right-to-left
 *   FR (France)  ⇄ 'fr' → French, left-to-right
 *
 * Route isolation:
 *   - /admin stays ALWAYS LTR (unchanged behaviour).
 *   - every other route keeps its existing behaviour (<html dir> follows the
 *     site language, as it always has for the storefront).
 *   - the market-scoped prefixes below additionally render their own subtree in
 *     the market's language and direction (they used to be pinned: /affiliate
 *     to French/LTR, /recruiter and the landing pages to Arabic/RTL).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const MARKETS = Object.freeze({
  MA: Object.freeze({ market: 'MA', lang: 'ar', dir: 'rtl' }),
  FR: Object.freeze({ market: 'FR', lang: 'fr', dir: 'ltr' }),
});

/** Route prefixes whose UI follows the market (language AND direction). */
export const MARKET_SCOPED_PREFIXES = Object.freeze(['/affiliate', '/recruiter', '/offer', '/tsajlim3ana']);

/** Route prefixes whose <html dir> is always LTR whatever the market (unchanged). */
export const ALWAYS_LTR_PREFIXES = Object.freeze(['/admin']);

const underPrefix = (pathname, prefix) =>
  typeof pathname === 'string' && (pathname === prefix || pathname.startsWith(`${prefix}/`));

export const isMarketScopedPath = (pathname) => MARKET_SCOPED_PREFIXES.some((p) => underPrefix(pathname, p));
// Raw startsWith, exactly as the pre-paint script and LanguageContext have always matched /admin.
export const isAlwaysLtrPath = (pathname) => typeof pathname === 'string' && ALWAYS_LTR_PREFIXES.some((p) => pathname.startsWith(p));

/** 'ar' | 'fr' for a site-language code; anything unknown → Arabic (the site fallback). */
export const marketLang = (lang) => (lang === 'fr' ? 'fr' : 'ar');
export const marketForLang = (lang) => (marketLang(lang) === 'fr' ? MARKETS.FR : MARKETS.MA);
export const marketDir = (lang) => marketForLang(lang).dir;

/** The <html dir> for a route and a site language — the single rule the pre-paint script and LanguageContext apply. */
export function htmlDirFor(pathname, lang) {
  if (isAlwaysLtrPath(pathname)) return 'ltr';
  return lang === 'ar' ? 'rtl' : 'ltr';
}

/**
 * Translator over a `{ ar, fr }` dictionary pair (the same shape as brandI18n):
 *   t('key', { n: 3 }) → interpolated text; a missing key falls back to the other
 *   language, then to the key itself — never throws.
 */
export function makeMarketT(dicts, lang) {
  const code = marketLang(lang);
  const own = dicts?.[code] ?? {};
  const other = dicts?.[code === 'ar' ? 'fr' : 'ar'] ?? {};
  return (key, vars) => {
    const raw = own[key] ?? other[key] ?? key;
    if (!vars || typeof raw !== 'string') return raw;
    return raw.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
  };
}

/** Locale for Intl number/date formatting in the market (digits stay Latin in both). */
export const marketIntlLocale = (lang) => (marketLang(lang) === 'fr' ? 'fr-MA' : 'ar-MA');

/**
 * `dir` for an input whose placeholder is localized text (phone, bank, free text): EMPTY → no attribute, so the field
 * (and its placeholder) inherits the market direction; FILLED → "auto", so a phone number / RIB renders LTR and an
 * Arabic name RTL. Deterministic in every browser (an empty dir="auto" field is LTR by the HTML spec).
 */
export const fieldDir = (value) => (value === undefined || value === null || String(value) === '' ? undefined : 'auto');
