import { Rubik } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
// PERF: SunEditor CSS removed from global layout.
//       It is now imported only inside admin pages that use the editor
//       (admin/blog/new, admin/pages/new, admin/product/new).
//       This removes ~300 KB from every public page load.
import MainFooterWrapper from "@/components/template/FooterClientWrapper";
import MainHeaderWrapper from "@/components/template/MainHeaderWrapper";
import ScriptInjector from "@/components/ScriptInjector";
import MetaPixel from "@/components/MetaPixel";
import ClarityScript from "@/components/ClarityScript";
import FloatingWhatsApp from "@/components/FloatingWhatsApp";
import UtmTracker from "@/components/UtmTracker";
import AffiliateRefCapture from "@/components/AffiliateRefCapture";
import TrackingCapture from "@/components/tracking/TrackingCapture";
import SpinWheelProvider from "@/components/SpinWheel/SpinWheelProvider";
import GiftSystemInit from "@/components/GiftSystem/GiftSystemInit";
import PreloaderWrapper from "@/components/PreloaderWrapper";
import { getStoreSettings } from "@/lib/getStoreSettings";
import { getPreloaderSettings } from "@/lib/getPreloaderSettings";
import { getIntegrationsSettings } from "@/lib/getIntegrationsSettings";
import { SITE_ORIGIN } from "@/lib/siteUrl";
import { Suspense } from "react";

// Rubik supports both Latin and Arabic scripts — load both subsets.
// PERF: Added display:"swap" → text renders in fallback font immediately,
//       preventing invisible-text flash (FOIT) which contributes to FCP delay.
// PERF: Removed weight "500" (font-medium) — not used in core UI paths;
//       eliminates one extra font file download.
const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["latin", "arabic"],
  weight: ["400", "600", "700"],
  display: "swap",
});

// Force dynamic rendering so favicon/title always reflect latest DB settings
export const dynamic = "force-dynamic";

// Generate metadata dynamically from store settings
const PROD_ORIGIN = SITE_ORIGIN;

/** Replace localhost URLs saved during development with the production origin */
function toAbsoluteUrl(url) {
  if (!url) return null;
  // Skip localhost / 127.0.0.1 URLs — they are invalid for og:image
  if (/localhost|127\.0\.0\.1/.test(url)) return null;
  // Already absolute → return as-is
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  // Relative path → prefix with production origin
  return `${PROD_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`;
}

export async function generateMetadata() {
  const settings = await getStoreSettings();

  const title       = settings?.storeName        || "Shop Gold - Online Shopping Experience";
  const description = settings?.websiteDescription || "Shop Gold is a modern online shopping experience built with Next.js";
  const image       = toAbsoluteUrl(settings?.ogImage) || toAbsoluteUrl(settings?.logoImage) || null;

  return {
    metadataBase: new URL(PROD_ORIGIN),
    title,
    description,
    // The admin-configured favicon is the PRIMARY icon; /favicon.ico (served
    // from public/) is only the fallback when Store Settings has none.
    //
    // The .ico file must stay in public/ and NEVER move into src/app/. A
    // favicon.ico inside the app directory is Next.js FILE-BASED metadata:
    // resolve-metadata.js unshifts it to the FRONT of icons.icon, so it is
    // emitted before this value and the tab keeps showing the static file no
    // matter what the admin uploads. A file in public/ is a plain static asset
    // and injects no <link>, so this stays the only rel="icon" tag.
    icons: {
      icon: settings?.faviconImage || "/favicon.ico",
    },
    openGraph: {
      title,
      description,
      url:      PROD_ORIGIN,
      siteName: title,
      ...(image ? { images: [{ url: image, alt: title }] } : {}),
      locale:   "fr_MA",
      type:     "website",
    },
    twitter: {
      card:        "summary_large_image",
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function RootLayout({ children }) {
  const preloaderConfig  = await getPreloaderSettings();
  const integrations     = await getIntegrationsSettings();
  return (
    // suppressHydrationWarning: LanguageProvider updates lang/dir client-side.
    // Default to Arabic (RTL) — matches the default language setting.
    <html
      lang="ar"
      dir="rtl"
      translate="no"
      className={rubik.variable}
      suppressHydrationWarning
    >
      {/* This tiny inline script runs in <head> — BEFORE the browser renders
           any content. This is intentionally render-blocking because it must
           set <html dir> before the first paint to prevent RTL flash on admin
           pages and LTR flash on Arabic storefront pages.
           ~200 bytes of JS: negligible parse/exec cost, huge UX benefit. */}
      <head>
        {/* Block Chrome/Google Translate popup — site has its own AR/FR switcher */}
        <meta name="google" content="notranslate" />
        {/* Facebook Domain Verification — loaded dynamically from DB */}
        {integrations?.metaDomainVerification && (
          <meta name="facebook-domain-verification" content={integrations.metaDomainVerification} />
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var l=localStorage.getItem('store_lang');var h=document.documentElement;var p=window.location.pathname;var a=p.startsWith('/admin');var g=p.split('/')[1];if((g==='affiliate'||g==='recruiter'||g==='offer'||g==='tsajlim3ana')&&l!=='ar')h.setAttribute('data-market-pending','');if(l==='fr'||l==='ar'){h.setAttribute('data-lang',l);h.setAttribute('lang',l);h.setAttribute('dir',(!a&&l==='ar')?'rtl':'ltr');}else{if(a)h.setAttribute('dir','ltr');}}catch(e){}}())`,
          }}
        />
      </head>
      <body className="antialiased">
        <Providers>
          {/*
            PreloaderWrapper wraps ALL visible content so it can:
            1. Keep content hidden (opacity-0) while the preloader is shown
            2. Crossfade both simultaneously once the page is ready
            Non-visual providers (trackers, scripts) stay outside so they
            are never blocked by the opacity wrapper.
          */}
          <AffiliateRefCapture />
          <UtmTracker />
          <Suspense fallback={null}>
            <TrackingCapture />
          </Suspense>
          <ScriptInjector integrations={integrations} />
          {/* Meta Pixel: receives ONLY { enabled, pixelIds } — no secret can
              travel in this prop. Suspense because it reads useSearchParams. */}
          <Suspense fallback={null}>
            <MetaPixel config={integrations?.metaPixel} />
          </Suspense>
          <ClarityScript />
          <Suspense fallback={null}>
            <PreloaderWrapper config={preloaderConfig}>
              <MainHeaderWrapper />
              {children}
              <MainFooterWrapper />
            </PreloaderWrapper>
          </Suspense>
          <SpinWheelProvider />
          <GiftSystemInit />
          <FloatingWhatsApp />
        </Providers>
      </body>
    </html>
  );
}
