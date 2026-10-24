"use client";

import { memo } from "react";
import { Heart } from "lucide-react";
import { isProductLocked } from "@/lib/productLock";
import { LockableLink, LockedOverlay } from "./ProductLock";

/**
 * ProductCard — the All-Products grid card.
 *
 * Markup extracted verbatim from ProductsClient so the feed can render hundreds
 * of cards without re-rendering them all: memo() means toggling one wishlist
 * heart re-renders one card, not the whole loaded list.
 *
 * The image keeps its fixed aspect-square box (no layout shift as pages append)
 * and is lazily decoded — with infinite scroll, off-screen images must not
 * compete with the next page's fetch.
 */
function ProductCard({ product, discountRule, isWishlisted, onWishlist, formatPrice }) {
  // Locked by the admin: still shown (image, name, price + lock) but not a link.
  const locked = isProductLocked(product);
  return (
    <div className="bg-white rounded-3xl border !border-purple-50 p-2 flex flex-col shadow-sm hover:shadow-md transition-all duration-300">
      {/* Image container */}
      <LockableLink locked={locked} href={`/products/${product._id}`}>
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-gray-100 to-gray-200 mb-3 aspect-square">
          <img
            src={product.images?.[0] || "https://placehold.co/400x500?text=No+Image"}
            alt={product.title}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover object-top"
          />
          {locked && <LockedOverlay />}

          {/* Product Label */}
          {product.productLabel && (
            <span className={`absolute top-2 start-2 px-1.5 py-0.5 text-xs font-medium rounded-lg backdrop-blur-sm ${
              product.productLabel === "New" ? "bg-gradient-to-r from-blue-500 to-blue-600 text-white"
              : product.productLabel === "Hot" ? "bg-gradient-to-r from-red-500 to-red-600 text-white"
              : product.productLabel === "Sale" ? "bg-gradient-to-r from-pink-500 to-pink-600 text-white"
              : product.productLabel === "Best Seller" ? "bg-gradient-to-r from-green-500 to-green-600 text-white"
              : product.productLabel === "Trending" ? "bg-gradient-to-r from-yellow-400 to-orange-400 text-black"
              : product.productLabel === "Limited Edition" ? "bg-gradient-to-r from-purple-500 to-purple-600 text-white"
              : "bg-gradient-to-r from-gray-700 to-gray-800 text-white"
            }`}>
              {product.productLabel}
            </span>
          )}

          {/* Rating badge */}
          {product.rating > 0 && (
            <div className="absolute bottom-2 start-2 bg-green-600 px-1.5 py-0.5 rounded-md flex items-center gap-1">
              <span className="text-xs text-white font-medium">{product.rating}</span>
              <span className="text-xs text-white font-semibold">★</span>
            </div>
          )}
          {/* Discount badge */}
          {discountRule && (
            <div className="absolute bottom-2 end-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">
              -{discountRule.percentage}%
            </div>
          )}

          {/* Wishlist button */}
          <button
            onClick={(e) => onWishlist(product, e)}
            className={`absolute top-2 end-2 p-1.5 rounded-full backdrop-blur-sm transition-all duration-200 hover:scale-110 ${
              isWishlisted ? "bg-red-500/90 text-white" : "bg-white/80 text-gray-600 hover:text-red-500"
            }`}
          >
            <Heart className={`w-3.5 h-3.5 ${isWishlisted ? "fill-current" : ""}`} />
          </button>
        </div>
      </LockableLink>

      {/* Info */}
      <div className="px-2 pb-2 flex flex-col flex-1">
        <LockableLink locked={locked} href={`/products/${product._id}`}>
          <h2 className="text-sm font-bold text-gray-900 line-clamp-1 leading-tight mb-1">{product.title}</h2>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-lg font-bold text-gray-900">
              {formatPrice(discountRule ? discountRule.effectivePrice : (product.salePrice || product.regularPrice || 0))}
            </span>
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

export default memo(ProductCard);
