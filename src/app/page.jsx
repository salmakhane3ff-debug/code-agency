"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import HomeSectionRenderer from "@/components/HomeBuilder/HomeSectionRenderer";
import { PurchasePopupStandalone } from "@/components/ConversionBadges";

// Above-fold components — imported normally so they appear in the initial bundle
// and are server-side rendered (or hydrated immediately client-side).
import Slider           from "@/components/Slider/Slider";
import SliderCollection from "@/components/Colleaction/SliderCollection";
import ProductGrid      from "@/components/Product/ProductGrid";
import { DEFAULT_PRODUCT_COUNT } from "@/lib/homepageProducts";
import Container        from "@/components/Container";

// PERF: Below-fold components — loaded with next/dynamic so their JS is only
//       downloaded after the above-fold content has painted.
//       ssr:false prevents SSR (these rely on browser APIs / IntersectionObserver).
const HomeCollectionSections = dynamic(
  () => import("@/components/Colleaction/HomeCollectionSections"),
  { ssr: false }
);
const VideoReels = dynamic(
  () => import("@/components/VideoReels"),
  { ssr: false }
);
const SupportBenefits = dynamic(
  () => import("@/components/SupportBenefits"),
  { ssr: false }
);
const HomeFeedbackSection = dynamic(
  () => import("@/components/HomeFeedbackSection"),
  { ssr: false }
);

function DefaultHome({ topOfferBanner }) {
  return (
    <div className="pb-10 space-y-10 md:space-y-16">
      {topOfferBanner?.image && (
        <Container>
          <a href={topOfferBanner.url || "#"} className="block">
            <img
              className="w-full rounded-xl md:h-[80px] object-cover"
              src={topOfferBanner.image}
              alt={topOfferBanner.title || "Top Offer"}
            />
          </a>
        </Container>
      )}
      <Container><Slider /></Container>
      <Container><SliderCollection /></Container>
      <Container><ProductGrid limit={DEFAULT_PRODUCT_COUNT} /></Container>
      {/* PERF: dynamic imports below — JS for these sections loads after LCP */}
      <HomeCollectionSections />
      <VideoReels />
      <SupportBenefits />
      <HomeFeedbackSection />
    </div>
  );
}

export default function Home() {
  const [topOfferBanner, setTopOfferBanner] = useState(null);
  const [layout, setLayout] = useState(undefined); // undefined=loading, null=none, array=custom

  useEffect(() => {
    // PERF: Both fetches run in parallel — previously sequential, adding ~200ms
    //       of waterfall latency per fetch on every page load.
    Promise.all([
      fetch("/api/data?collection=top-offer-banner")
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
      fetch("/api/setting?type=homepage_layout", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})),
    ]).then(([bannerData, layoutData]) => {
      if (Array.isArray(bannerData) && bannerData.length > 0) {
        setTopOfferBanner(bannerData[0]);
      }
      setLayout(
        Array.isArray(layoutData?.sections) && layoutData.sections.length > 0
          ? layoutData.sections
          : null
      );
    });
  }, []);

  // While fetching layout, show nothing to avoid flash
  if (layout === undefined) return <div className="min-h-screen" />;

  // Custom layout saved → pass sections as prop so HomeSectionRenderer
  // can skip its own duplicate fetch of homepage_layout.
  if (layout !== null) return (
    <>
      <HomeSectionRenderer sections={layout} />
      <PurchasePopupStandalone />
    </>
  );

  // No custom layout → fallback
  return (
    <>
      <DefaultHome topOfferBanner={topOfferBanner} />
      <PurchasePopupStandalone />
    </>
  );
}
