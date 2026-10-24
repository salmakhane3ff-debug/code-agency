"use client";
import { useEffect, useState, useCallback, memo } from "react";
import Image from "next/image";
import ProductLabel from "@/components/ProductLabel";
import Link from "next/link";
import { Skeleton } from "@heroui/skeleton";
import { ShoppingCart, Clock, Heart } from "lucide-react";
import { Button } from "@heroui/react";
import { useCart } from "@/hooks/useCart";
import { useLanguage } from "@/context/LanguageContext";
import { isProductLocked } from "@/lib/productLock";
import { LockableLink, LockedOverlay } from "./ProductLock";
import { useDiscountRules } from "@/hooks/useDiscountRules";
import { fetchCached } from "@/lib/dataCache";

// WHY: Static array prevents Array(10) allocation on every loading render cycle.
const SKELETON_ITEMS = Array.from({ length: 10 }, (_, i) => i);

// WHY: memo() prevents ProductGrid from re-rendering when a parent component
// re-renders with the same props (e.g. homepage re-renders due to unrelated state).
function StyleOne() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [wishlist, setWishlist] = useState([]);
  const { addToCart, isAddingToCart } = useCart();
  const { t, formatPrice } = useLanguage();
  const { getDiscount } = useDiscountRules();

  useEffect(() => {
    let cancelled = false;
    async function fetchProducts() {
      try {
        // fetchCached deduplicates: all components share one in-flight request
        const data = await fetchCached("/api/products");
        if (!cancelled) setProducts(Array.isArray(data) && data.length > 0 ? data : []);
      } catch (err) {
        console.error("Failed to fetch products:", err);
        if (!cancelled) {
          setError("Failed to load products");
          setProducts([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    const savedWishlist = JSON.parse(localStorage.getItem("wishlist") || "[]");
    setWishlist(savedWishlist);
    fetchProducts();

    // WHY: Cleanup flag prevents setState on an unmounted component, which causes
    // React "Can't perform state update on unmounted component" warnings and
    // potential memory leaks if the component unmounts before the fetch resolves.
    return () => { cancelled = true; };
  }, []);

  // WHY: useCallback keeps these functions referentially stable across renders,
  // avoiding unnecessary re-renders of any child that receives them as props.
  const navigateProduct = useCallback((product, e) => {
    if (
      product.redirectMode === "landing" &&
      typeof product.redirectUrl === "string" &&
      product.redirectUrl.trim()
    ) {
      if (e && typeof e.preventDefault === "function") {
        e.preventDefault();
        e.stopPropagation();
      }
      window.location.href = product.redirectUrl.trim();
      return true;
    }
    return false;
  }, []);

  // WHY: DOM-based notification replaced with a safe self-cleaning approach.
  // Previous version used raw setTimeout without cleanup — if the component
  // unmounted before the 2000ms elapsed, the callback would still fire and try
  // to remove a node that may no longer exist, causing silent errors.
  const showNotification = useCallback((message, isError = false) => {
    const el = document.createElement("div");
    el.textContent = message;
    el.className = `fixed top-4 right-4 ${isError ? "bg-red-500" : "bg-green-500"} text-white px-4 py-2 rounded-lg shadow-lg z-50 transition-opacity`;
    document.body.appendChild(el);
    const hideTimer = setTimeout(() => {
      el.style.opacity = "0";
      const removeTimer = setTimeout(() => {
        if (document.body.contains(el)) document.body.removeChild(el);
      }, 300);
      // Store remove timer on element so it can be cancelled if needed
      el._removeTimer = removeTimer;
    }, isError ? 3000 : 2000);
    el._hideTimer = hideTimer;
  }, []);

  const handleAddToCart = useCallback(async (product, e) => {
    if (e && typeof e.preventDefault === "function") {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      await addToCart(product, 1);
      showNotification(`${product.title} — ${t("product_added_to_cart")}`);
    } catch (err) {
      console.error("Failed to add product to cart:", err);
      showNotification(t("product_add_failed"), true);
    }
  }, [addToCart, t, showNotification]);

  const handleWishlist = useCallback((product, e) => {
    e.preventDefault();
    e.stopPropagation();
    const wishlistItem = {
      productId: product._id,
      title: product.title,
      image: product.images?.[0],
      price: product.salePrice || product.regularPrice,
      regularPrice: product.regularPrice,
      salePrice: product.salePrice,
      currency: "MAD",
      rating: product.rating,
      productLabel: product.productLabel,
      addedAt: new Date().toISOString(),
    };

    // WHY: Functional setState update reads the latest prev value — avoids stale
    // closure bug where wishlist could be the value from a previous render cycle.
    setWishlist((prev) => {
      const exists = prev.some((item) => item.productId === product._id);
      const updated = exists
        ? prev.filter((item) => item.productId !== product._id)
        : [...prev, wishlistItem];
      localStorage.setItem("wishlist", JSON.stringify(updated));
      window.dispatchEvent(new Event("wishlistUpdated"));
      return updated;
    });
  }, []);

  const isInWishlist = useCallback(
    (productId) => wishlist.some((item) => item.productId === productId),
    [wishlist]
  );

  const calculateDiscount = useCallback((regularPrice, salePrice) => {
    if (!salePrice || !regularPrice) return 0;
    return Math.round(((regularPrice - salePrice) / regularPrice) * 100);
  }, []);

  const isLimitedTimeDeal = useCallback((limitedTimeDeal) => {
    if (!limitedTimeDeal) return false;
    return new Date(limitedTimeDeal).getTime() > Date.now();
  }, []);

  const getTimeRemaining = useCallback((limitedTimeDeal) => {
    if (!limitedTimeDeal) return "";
    const timeLeft = new Date(limitedTimeDeal).getTime() - Date.now();
    if (timeLeft <= 0) return t("product_expired");
    const hours = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days} ${t("product_days_left")}`;
    }
    return `${hours}h ${minutes}m ${t("product_hours_min_left")}`;
  }, [t]);

  if (loading) {
    return (
      <div className="container mx-auto md:px-20 px-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
          {SKELETON_ITEMS.map((i) => (
            <div key={i} className="bg-white rounded-3xl border border-purple-50 p-2">
              <Skeleton className="w-full rounded-2xl" style={{ height: 220 }} />
              <div className="px-2 mt-4 space-y-2">
                <Skeleton className="h-3 w-16 rounded" />
                <Skeleton className="h-4 w-full rounded" />
                <Skeleton className="h-3 w-3/4 rounded" />
                <Skeleton className="h-6 w-24 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (products.length === 0) return null;

  const displayProducts = products.slice(0, 10);
  const hasMoreProducts = products.length > 10;

  return (
    <div className="container mx-auto md:px-20">
      {/* Section header */}
      <div className="text-center mb-8">
        <h1 className="text-xl md:text-2xl font-bold text-gray-900 mb-2">{t("nav_products")}</h1>
        <p className="text-sm text-gray-500">{t("product_grid_subtitle")}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4 px-4">
        {displayProducts.map((product, index) => {
          const discount    = calculateDiscount(product.regularPrice, product.salePrice);
          const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv|ogv)(\?.*)?$/i;
          const imageUrl = (() => {
            const list = Array.isArray(product.images) ? product.images : [];
            const found = list.find(img => !VIDEO_EXT.test(img?.url || img || ""));
            return found?.url || found || "https://placehold.co/400x500?text=No+Image";
          })();
          const productHref = `/products/${product._id}`;
          // PERF: First 2 products are above the fold — mark as priority (LCP candidates).
          //       All others load lazily.
          const isAboveFold = index < 2;
          // Resolve collection name — skip raw IDs (numbers / short strings)
          const rawCol      = Array.isArray(product.collections) ? product.collections[0] : null;
          const colName     = typeof rawCol === "string" && rawCol.length > 4 ? rawCol
                            : rawCol?.title || rawCol?.name || null;

          const discountRule = getDiscount(product);
          // Locked by the admin: still shown (image, name, price + lock), never a link.
          const locked       = isProductLocked(product);

          return (
            <div
              key={product._id}
              className="bg-white rounded-3xl glass-card border !border-purple-50 p-2 flex flex-col shadow-sm hover:shadow-md transition-all duration-300"
            >
              {/* Image */}
              <LockableLink anchor locked={locked} href={productHref} onClick={(e) => navigateProduct(product, e)}>
                <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-gray-100 to-gray-200 mb-3 aspect-square">
                  {/* PERF: <Image fill> replaces raw <img>.
                           - fill: fills the positioned aspect-square container (no CLS)
                           - sizes: gives browser the right srcset slot per breakpoint
                           - priority / fetchPriority: first 2 cards are LCP candidates
                           - quality={80}: ~35% smaller files vs default 75 */}
                  <Image
                    src={imageUrl}
                    alt={product.title}
                    fill
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                    className="object-cover object-top"
                    priority={isAboveFold}
                    fetchPriority={isAboveFold ? "high" : "auto"}
                    quality={80}
                  />
                  {locked && <LockedOverlay />}
                  {!!product.productLabel && (
                    <div className="absolute top-2 start-2">
                      <ProductLabel label={product.productLabel} />
                    </div>
                  )}
                  {product.rating > 0 && (
                    <div className="absolute bottom-2 start-2 bg-green-600/90 px-2 py-0.5 rounded-md flex items-center gap-1">
                      <span className="text-xs text-white font-medium">{product.rating}</span>
                      <span className="text-xs text-white">★</span>
                    </div>
                  )}
                  {discountRule && (
                    <div className="absolute bottom-2 end-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                      -{discountRule.percentage}%
                    </div>
                  )}
                  {/* Wishlist */}
                  <button
                    onClick={(e) => handleWishlist(product, e)}
                    className={`absolute top-2 end-2 p-1.5 rounded-full backdrop-blur-sm transition-all duration-200 hover:scale-110 ${
                      isInWishlist(product._id)
                        ? "bg-red-500/90 text-white"
                        : "bg-white/80 text-gray-600 hover:text-red-500"
                    }`}
                  >
                    <Heart className={`w-3.5 h-3.5 ${isInWishlist(product._id) ? "fill-current" : ""}`} />
                  </button>
                </div>
              </LockableLink>

              {/* Info */}
              <div className="px-2 pb-2 flex flex-col flex-1">

                <LockableLink anchor locked={locked} href={productHref} onClick={(e) => navigateProduct(product, e)}>
                  <h2 className="text-sm font-bold text-gray-900 line-clamp-1 leading-tight">
                    {product.title}
                  </h2>
                </LockableLink>

                {product.shortDescription && (
                  <p className="text-xs text-gray-600 line-clamp-1 my-1 leading-normal">
                    {product.shortDescription}
                  </p>
                )}

                {/* Price row */}
                <div className="flex items-center gap-2 mt-1 mb-2 flex-wrap">
                  <span className="text-lg font-bold text-gray-900">
                    {formatPrice(discountRule ? discountRule.effectivePrice : (product.salePrice || product.regularPrice || 0))}
                  </span>
                  {(discountRule || (product.salePrice && product.regularPrice)) && (
                    <span className="text-xs text-gray-400 line-through">
                      {formatPrice(discountRule ? discountRule.originalPrice : product.regularPrice)}
                    </span>
                  )}
                </div>

              </div>
            </div>
          );
        })}
      </div>

      {hasMoreProducts && (
        <div className="flex justify-center mt-10">
          <Link href="/products">
            <Button className="bg-gray-900 text-white font-medium rounded-2xl px-10 py-2 text-sm">
              {t("product_view_more")}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}

// WHY: memo() does a shallow prop comparison before re-rendering. Since StyleOne
// takes no props, it will NEVER re-render due to parent re-renders — only when
// its own internal state changes. This prevents homepage re-renders from cascading
// into a full product-grid re-render + layout recalculation.
export default memo(StyleOne);
