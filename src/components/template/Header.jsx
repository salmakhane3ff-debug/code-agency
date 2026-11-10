"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
// PERF: framer-motion removed (~78 KB JS). Sidebar slide + backdrop fade
//       are now handled with CSS transitions (zero JS cost).
import { RiMenuLine } from "react-icons/ri";
import { IoBagOutline } from "react-icons/io5";
import { DynamicIcon } from "lucide-react/dynamic";
import { ShoppingCart, Search, Heart, Star } from "lucide-react";
import Link from "next/link";
import { useUIControl } from "@/hooks/useUIControl";
import { useLanguage } from "@/context/LanguageContext";
import LanguageSwitcher from "@/components/template/LanguageSwitcher";
import { usePathname } from "next/navigation";
import { isMarketScopedPath } from "@/lib/marketLocale";
import { MarketLanguageSwitcher, useHydrated, useMarketLocale } from "@/context/useMarketLocale";

// Market-scoped routes (affiliate area, /tsajlim3ana) render this store header too. There only, the selector shows the
// visitor's market as active with localized labels, and the hydration-stale aria-labels below are refreshed once
// after hydration (key change). Every other route renders exactly as before (no key, the plain LanguageSwitcher).
const HEADER_MARKET_TEXT = Object.freeze({ ar: Object.freeze({ menu: "القائمة" }), fr: Object.freeze({ menu: "Menu" }) });

export default function FullHeader() {
  const ui = useUIControl();
  const { t, dir } = useLanguage();
  const isRTL = dir === "rtl";
  const marketRoute = isMarketScopedPath(usePathname());
  const hydrated = useHydrated();
  const { t: mt } = useMarketLocale(HEADER_MARKET_TEXT);
  // undefined on every non-market route → no remount, identical markup.
  const marketKey = marketRoute ? (hydrated ? "client" : "server") : undefined;
  const Switcher = marketRoute ? MarketLanguageSwitcher : LanguageSwitcher;

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuItems, setMenuItems] = useState([]);
  const [storeSettings, setStoreSettings] = useState(null);
  const [wishlistCount, setWishlistCount] = useState(0);
  const [cartCount, setCartCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  // Hydration guard: sidebar and backdrop are only rendered after the client has
  // mounted. This prevents a server/client mismatch caused by isRTL and t() reading
  // client-side state (localStorage / cookie) that differs from the SSR pass.
  // Since menuOpen is always false at startup, users cannot open the menu before
  // hydration, so there is zero visual impact.
  const [mounted, setMounted] = useState(false);

  const updateWishlistCount = useCallback(() => {
    const savedWishlist = JSON.parse(localStorage.getItem("wishlist") || "[]");
    setWishlistCount(savedWishlist.length);
  }, []);

  const updateCartCount = useCallback(() => {
    const savedCart = JSON.parse(localStorage.getItem("cart") || "[]");
    const totalItems = savedCart.reduce((total, item) => total + (item.quantity || 1), 0);
    setCartCount(totalItems);
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [menuRes, settingsRes] = await Promise.all([
          fetch("/api/data?collection=menu-item", {}),
          fetch("/api/setting?type=store", {}),
        ]);

        if (menuRes.ok) {
          const menuData = await menuRes.json();
          const sorted = [...menuData].sort((a, b) => (a.position ?? 9999) - (b.position ?? 9999));
          setMenuItems(sorted);
        }

        if (settingsRes.ok) {
          const settingsData = await settingsRes.json();
          if (settingsData && Object.keys(settingsData).length > 0) {
            setStoreSettings(settingsData);
          }
        }
      } catch (err) {
        console.error("Failed to load data:", err);
      } finally {
        setIsLoading(false);
      }
    };

    setMounted(true);
    fetchData();
    updateWishlistCount();
    updateCartCount();

    const handleStorageChange = (e) => {
      if (e.key === "wishlist") updateWishlistCount();
      if (e.key === "cart") updateCartCount();
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("wishlistUpdated", updateWishlistCount);
    window.addEventListener("cartUpdated", updateCartCount);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("wishlistUpdated", updateWishlistCount);
      window.removeEventListener("cartUpdated", updateCartCount);
    };
  }, [updateWishlistCount, updateCartCount]);

  // PERF: Prefer the -sm.webp thumbnail (300px WebP) over the raw upload.
  //       The logo displays at h-12 (48px) — serving a 340KB PNG for that is wasteful.
  //       Falls back to original if thumbnail doesn't exist (old uploads without thumbs).
  const logoSrc = useMemo(() => {
    const raw = storeSettings?.logoImage;
    if (!raw) return "/logonc.svg";
    if (raw.startsWith('/uploads/')) {
      const base = raw.replace(/\.[^.]+$/, '');   // strip extension
      return `${base}-sm.webp`;                   // e.g. /uploads/1234-logo-sm.webp
    }
    return raw;
  }, [storeSettings?.logoImage]);

  // Original full-res URL used as <img onError> fallback for logos uploaded
  // before the thumbnail system was introduced (they won't have a -sm.webp file).
  const logoFallback = useMemo(
    () => storeSettings?.logoImage || "/logonc.svg",
    [storeSettings?.logoImage]
  );
  const storeName = useMemo(() => storeSettings?.textLogo || storeSettings?.storeName || "", [storeSettings]);
  const displayMenuItems = useMemo(() => menuItems, [menuItems]);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // PERF: sidebar position class — no framer-motion needed, pure CSS transform
  const sidebarPosition = isRTL ? "right-0" : "left-0";
  // PERF: translate direction — sidebar starts off-screen, slides to x:0 on open
  const sidebarTranslate = menuOpen
    ? "translate-x-0"
    : isRTL
    ? "translate-x-full"
    : "-translate-x-full";

  return (
    <>
      <header className="w-full text-sm bg-white shadow sticky top-0 z-40">
        <div className="container mx-auto flex items-center h-12 px-2 md:px-20 relative">

          {/* ── LEFT: Menu + Search + Feedback ── */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMenuOpen(true)}
              className="text-black text-xl p-2 cursor-pointer"
              aria-label={marketRoute ? mt("menu") : undefined}
            >
              <RiMenuLine />
            </button>

            <Link
              href="/products"
              className="p-2.5 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors"
              prefetch={true}
              key={marketKey ? `nav_search-${marketKey}` : undefined}
              aria-label={t("nav_search")}
              suppressHydrationWarning
            >
              <svg stroke="currentColor" fill="none" strokeWidth="0" viewBox="0 0 24 24" height="18" width="18" xmlns="http://www.w3.org/2000/svg">
                <path fillRule="evenodd" clipRule="evenodd" d="M18.319 14.4326C20.7628 11.2941 20.542 6.75347 17.6569 3.86829C14.5327 0.744098 9.46734 0.744098 6.34315 3.86829C3.21895 6.99249 3.21895 12.0578 6.34315 15.182C9.22833 18.0672 13.769 18.2879 16.9075 15.8442C16.921 15.8595 16.9351 15.8745 16.9497 15.8891L21.1924 20.1317C21.5829 20.5223 22.2161 20.5223 22.6066 20.1317C22.9971 19.7412 22.9971 19.1081 22.6066 18.7175L18.364 14.4749C18.3493 14.4603 18.3343 14.4462 18.319 14.4326ZM16.2426 5.28251C18.5858 7.62565 18.5858 11.4246 16.2426 13.7678C13.8995 16.1109 10.1005 16.1109 7.75736 13.7678C5.41421 11.4246 5.41421 7.62565 7.75736 5.28251C10.1005 2.93936 13.8995 2.93936 16.2426 5.28251Z" fill="currentColor" />
              </svg>
            </Link>

            {ui.showFeedbackBarIcon && (
              <Link
                href="/feedback"
                className="p-2.5 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors"
                prefetch={true}
              >
                <Star className="w-[18px] h-[18px] fill-yellow-400 text-yellow-400" />
              </Link>
            )}
          </div>

          {/* ── CENTER: Logo — always perfectly centered ── */}
          <Link href="/" className="flex items-center absolute left-1/2 -translate-x-1/2">
            {storeSettings?.logoImage ? (
              <img
                src={logoSrc}
                alt={storeName}
                className="h-12 w-auto"
                fetchPriority="high"
                loading="eager"
                onError={e => { e.currentTarget.onerror = null; e.currentTarget.src = logoFallback; }}
              />
            ) : (
              <span className="font-bold text-lg">{storeName}</span>
            )}
          </Link>

          {/* ── RIGHT: Language + Wishlist + Cart ── */}
          <div className="flex items-center gap-1 ms-auto">
            <div className="hidden md:flex items-center me-1">
              <Switcher />
            </div>

            {ui.showWishlistIcon && (
              <Link
                href="/wishlist"
                className="relative p-2.5 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors"
                prefetch={true}
                key={marketKey ? `nav_wishlist-${marketKey}` : undefined}
              aria-label={t("nav_wishlist")}
                suppressHydrationWarning
              >
                <Heart className="w-[18px] h-[18px]" />
                {wishlistCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {wishlistCount}
                  </span>
                )}
              </Link>
            )}

            {ui.showCartIcon && (
              <Link
                href="/cart"
                className="relative p-2.5 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors"
                prefetch={true}
                key={marketKey ? `nav_cart-${marketKey}` : undefined}
              aria-label={t("nav_cart")}
                suppressHydrationWarning
              >
                <IoBagOutline size={20} />
                {cartCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {cartCount}
                  </span>
                )}
              </Link>
            )}
          </div>

        </div>
      </header>

      {/* Mobile Sidebar — CSS transitions replace framer-motion (~78 KB saved).
          Gated on `mounted` so SSR never outputs RTL-dependent classes or translated
          strings, eliminating the server/client hydration mismatch entirely.
          Since menuOpen is always false at first render, there is no visible flicker. */}
      {mounted && (
        <>
          {/* Backdrop */}
          <div
            className={`fixed inset-0 backdrop-blur-sm bg-white/30 z-50 transition-opacity duration-300 ${
              menuOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
            }`}
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />

          {/* Sidebar panel */}
          <div
            className={`fixed top-0 ${sidebarPosition} bottom-0 w-[85%] max-w-sm bg-white z-50 flex flex-col overflow-y-auto transform transition-transform duration-300 ease-in-out ${sidebarTranslate}`}
          >
              {/* Header Section */}
              <div className="relative bg-gray-50 border-b border-gray-200 px-4 py-6 pt-8">
                <button
                  onClick={closeMenu}
                  className={`absolute top-4 ${isRTL ? "left-4" : "right-4"} text-gray-600 hover:text-gray-800 text-2xl cursor-pointer z-10 w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-200 transition-colors`}
                >
                  ×
                </button>

                <div className={`flex items-center gap-3 ${isRTL ? "pl-12" : "pr-12"}`}>
                  {storeSettings?.logoImage ? (
                    <img
                      src={logoSrc}
                      alt={storeName}
                      className="h-12 w-auto"
                      onError={e => { e.currentTarget.onerror = null; e.currentTarget.src = logoFallback; }}
                    />
                  ) : (
                    <span className="font-bold text-lg text-gray-800">{storeName}</span>
                  )}
                </div>

                <p className="text-xs text-gray-500 mt-2">{t("nav_store")}</p>

                {/* Language switcher inside mobile sidebar */}
                <div className="mt-3">
                  <Switcher />
                </div>
              </div>

              {/* Mobile Menu List */}
              <div className="flex flex-col px-4 py-6 gap-1 flex-1">
                {displayMenuItems.length > 0 ? (
                  displayMenuItems.map(({ _id, title, url, iconName, badge }) => (
                    <a
                      href={url}
                      key={_id}
                      className="flex items-center justify-between py-4 px-3 rounded-lg hover:bg-gray-50 transition-colors group border-b border-gray-100 last:border-b-0"
                      onClick={closeMenu}
                    >
                      <div className="flex items-center gap-4 text-gray-700 text-sm font-medium group-hover:text-gray-900">
                        <span className="text-gray-500 group-hover:text-blue-600 transition-colors">
                          <DynamicIcon name={iconName || "help-circle"} size={20} />
                        </span>
                        <span className="capitalize">{title}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {badge && (
                          <span className="text-[10px] bg-green-100 text-green-700 px-2 py-1 rounded-full font-semibold">
                            {badge}
                          </span>
                        )}
                        <span className="text-gray-400 group-hover:text-gray-600 transition-colors">
                          <DynamicIcon name={isRTL ? "chevron-left" : "chevron-right"} size={16} />
                        </span>
                      </div>
                    </a>
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="text-gray-300 mb-4">
                      <RiMenuLine className="text-5xl" />
                    </div>
                    <p className="text-gray-500 text-sm font-medium">{t("nav_no_menu")}</p>
                    <p className="text-gray-400 text-xs mt-2 max-w-48">{t("nav_add_menu_hint")}</p>
                  </div>
                )}
              </div>

              {/* Footer */}
              {displayMenuItems.length > 0 && (
                <div className="border-t border-gray-200 px-4 py-4 bg-gray-50">
                  <div className="flex items-center justify-center gap-6 text-xs text-gray-500">
                    <span>
                      © {new Date().getFullYear()} {storeName}
                    </span>
                  </div>
                </div>
              )}
          </div>
        </>
      )}
    </>
  );
}
