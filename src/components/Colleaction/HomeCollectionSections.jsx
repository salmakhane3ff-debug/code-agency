"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLanguage } from "@/context/LanguageContext";
import { useDiscountRules } from "@/hooks/useDiscountRules";
import { fetchCached } from "@/lib/dataCache";
import { thumbUrl }    from "@/lib/thumbnailUrl";
import { isProductLocked } from "@/lib/productLock";
import { LockableLink, LockedOverlay } from "@/components/Product/ProductLock";

// ── Product Card ──────────────────────────────────────────────────────────────

const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv|ogv)(\?.*)?$/i;
function getProductImageUrl(images) {
  const list = Array.isArray(images) ? images : [];
  const found = list.find(img => {
    const url = (img?.url || img || "");
    return !VIDEO_EXT.test(url);
  });
  return found?.url || found || "https://placehold.co/400x400?text=No+Image";
}

function ProductCard({ product, formatPrice, getDiscount, priority = false }) {
  const _rawUrl  = getProductImageUrl(product.images);
  // PERF: use 200px WebP thumbnail for grid cards (~200px display size).
  // LCP card (priority=true) uses the larger lg thumbnail for better quality.
  const imageUrl = thumbUrl(_rawUrl, priority ? "lg" : "md") || _rawUrl;
  const discountRule = getDiscount ? getDiscount(product) : null;
  const price        = discountRule ? discountRule.effectivePrice : (product.salePrice || product.regularPrice);
  const href         = `/products/${product._id || product.id}`;
  const locked       = isProductLocked(product);   // shown, but not a link

  return (
    <div className="bg-white rounded-3xl border border-purple-50 p-2 flex flex-col shadow-sm hover:shadow-md transition-all duration-300">
      <LockableLink locked={locked} href={href}>
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-gray-100 to-gray-200 mb-3 aspect-square">
          {/* PERF: first card in the first collection is the LCP candidate —
              load it eagerly with high fetch priority. All other cards stay lazy. */}
          <img
            src={imageUrl}
            alt={product.title}
            className="absolute inset-0 w-full h-full object-cover object-top"
            loading={priority ? "eager" : "lazy"}
            fetchpriority={priority ? "high" : "auto"}
            decoding={priority ? "sync" : "async"}
          />
          {locked && <LockedOverlay />}
          {product.productLabel && (
            <span className={`absolute top-2 left-2 px-1.5 py-0.5 text-[10px] font-semibold rounded-md backdrop-blur-sm ${
              product.productLabel === "New"  ? "bg-blue-500 text-white"
              : product.productLabel === "Hot"  ? "bg-red-500 text-white"
              : product.productLabel === "Sale" ? "bg-pink-500 text-white"
              : "bg-gray-800 text-white"
            }`}>
              {product.productLabel}
            </span>
          )}
          {discountRule && (
            <span className="absolute bottom-2 right-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
              -{discountRule.percentage}%
            </span>
          )}
        </div>
      </LockableLink>
      <div className="px-1 pb-1 flex flex-col flex-1">
        <LockableLink locked={locked} href={href}>
          <h3 className="text-sm font-bold text-gray-900 line-clamp-1 leading-tight mb-1">{product.title}</h3>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-base font-bold text-gray-900">{formatPrice(price)}</span>
            {(discountRule || (product.salePrice && product.regularPrice > 0)) && (
              <span className="text-xs line-through text-gray-400">
                {formatPrice(discountRule ? discountRule.originalPrice : product.regularPrice)}
              </span>
            )}
          </div>
        </LockableLink>
      </div>
    </div>
  );
}

// ── Collection Section ────────────────────────────────────────────────────────

function CollectionSection({ collection, allProducts, formatPrice, t, getDiscount, isFirstSection = false }) {
  const limit = collection.homepageProductLimit || 4;

  const products = allProducts
    .filter((p) =>
      Array.isArray(p.collections) &&
      p.collections.some((c) => c.toLowerCase() === collection.title.toLowerCase())
    )
    .slice(0, limit);

  return (
    <section className="md:mt-16 mt-10">
      <div className="max-w-7xl mx-auto px-4 mb-6 text-center">
        <h2 className="text-xl md:text-2xl font-bold text-gray-900">{collection.title}</h2>
        {collection.description && (
          <p className="text-sm text-gray-500 mt-1">{collection.description}</p>
        )}
      </div>

      {products.length === 0 && (
        <div className="max-w-7xl mx-auto px-4">
          <p className="text-sm text-gray-400 italic">
            No products assigned to this collection yet. Go to Admin → Products and set the collection to &quot;{collection.title}&quot;.
          </p>
        </div>
      )}

      {products.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
            {products.map((product, idx) => (
              <ProductCard
                key={product._id || product.id}
                product={product}
                formatPrice={formatPrice}
                getDiscount={getDiscount}
                // PERF: first card of the first collection is the LCP candidate.
                priority={isFirstSection && idx === 0}
              />
            ))}
          </div>
          <div className="flex justify-center mt-8">
            <Link href={`/products?collection=${encodeURIComponent(collection.title)}`}>
              <button className="px-8 py-2 bg-gray-900 text-white text-sm font-semibold rounded-2xl hover:bg-gray-700 transition-colors">
                {t("product_view_more")}
              </button>
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

// ── Single Collection Section (used by Homepage Builder) ──────────────────────
// Supports two modes:
//   auto   — fetches products that belong to the chosen collection (original behaviour)
//   manual — displays exactly the products in `selectedProducts`, in that order

export function SingleCollectionSection({
  collectionTitle,
  collectionId,
  productLimit    = 8,
  customTitle     = "",
  showViewMore    = true,
  mode            = "auto",
  selectedProducts = [],
}) {
  const [allProducts, setAllProducts] = useState([]);
  const [collection,  setCollection]  = useState(null);
  const [loading,     setLoading]     = useState(true);
  const { formatPrice, t } = useLanguage();
  const { getDiscount }    = useDiscountRules();

  // Stable key for the selectedProducts array so the effect only re-runs when
  // the actual selection changes, not on every parent re-render.
  const selectedKey = selectedProducts.join(",");

  useEffect(() => {
    if (mode === "manual") {
      // Manual: we only need the full product list to look up by ID.
      if (selectedProducts.length === 0) { setLoading(false); return; }
      fetchCached("/api/products")
        .then(prods => setAllProducts(Array.isArray(prods) ? prods : []))
        .catch(() => {})
        .finally(() => setLoading(false));
    } else {
      // Auto: original behaviour — find collection, then filter products.
      if (!collectionTitle && !collectionId) { setLoading(false); return; }
      Promise.all([
        fetchCached("/api/collection"),
        fetchCached("/api/products"),
      ])
        .then(([cols, prods]) => {
          const col = cols.find(c =>
            (collectionId  && (c._id || c.id) === collectionId) ||
            (collectionTitle && c.title.toLowerCase() === collectionTitle.toLowerCase())
          );
          setCollection(col || null);
          setAllProducts(Array.isArray(prods) ? prods : []);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [collectionTitle, collectionId, mode, selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return null;

  // ── Resolve the product list to display ──────────────────────────────────
  let products;
  let heading;
  let viewMoreHref;

  if (mode === "manual") {
    if (selectedProducts.length === 0) return null;
    // Build a lookup map and preserve the admin-defined order.
    const productMap = Object.fromEntries(allProducts.map(p => [p._id || p.id, p]));
    products = selectedProducts
      .map(id => productMap[id])
      .filter(Boolean)           // skip IDs that no longer exist
      .slice(0, productLimit);   // max products = display limit only
    heading      = customTitle || "";
    // Link to the collection page if a title/id is known, otherwise hide the button
    viewMoreHref = collectionTitle
      ? `/products?collection=${encodeURIComponent(collectionTitle)}`
      : null;
  } else {
    // Auto mode — requires a matched collection.
    if (!collection) return null;
    products = allProducts
      .filter(p =>
        Array.isArray(p.collections) &&
        p.collections.some(c => c.toLowerCase() === collection.title.toLowerCase())
      )
      .slice(0, productLimit);
    heading     = customTitle || collection.title;
    viewMoreHref = `/products?collection=${encodeURIComponent(collection.title)}`;
  }

  if (products.length === 0) return null;

  return (
    <section>
      {heading && (
        <div className="max-w-7xl mx-auto px-4 mb-6 text-center">
          <h2 className="text-xl md:text-2xl font-bold text-gray-900">{heading}</h2>
          {mode === "auto" && collection?.description && (
            <p className="text-sm text-gray-500 mt-1">{collection.description}</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
        {products.map((product, idx) => (
          <ProductCard
            key={product._id || product.id}
            product={product}
            formatPrice={formatPrice}
            getDiscount={getDiscount}
            // PERF: first card can be the LCP candidate when rendered at top of page.
            priority={idx === 0}
          />
        ))}
      </div>

      {showViewMore && viewMoreHref && (
        <div className="flex justify-center mt-8">
          <Link href={viewMoreHref}>
            <button className="px-8 py-2 bg-gray-900 text-white text-sm font-semibold rounded-2xl hover:bg-gray-700 transition-colors">
              {t("product_view_more")}
            </button>
          </Link>
        </div>
      )}
    </section>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function HomeCollectionSections() {
  const [collections,  setCollections]  = useState([]);
  const [allProducts,  setAllProducts]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const { formatPrice, t } = useLanguage();
  const { getDiscount } = useDiscountRules();

  useEffect(() => {
    async function load() {
      try {
        const [cols, prods] = await Promise.all([
          fetchCached("/api/collection"),
          fetchCached("/api/products"),
        ]);
        setCollections(Array.isArray(cols)  ? cols  : []);
        setAllProducts(Array.isArray(prods) ? prods : []);
      } catch (e) {
        console.error("HomeCollectionSections fetch error:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading || collections.length === 0) return null;

  return (
    <>
      {collections.map((col, idx) => (
        <div key={col._id || col.id}>
          <CollectionSection
            collection={col}
            allProducts={allProducts}
            formatPrice={formatPrice}
            t={t}
            getDiscount={getDiscount}
            isFirstSection={idx === 0}
          />
        </div>
      ))}
    </>
  );
}
