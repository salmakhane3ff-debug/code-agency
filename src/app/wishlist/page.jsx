"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Heart, ShoppingCart, Trash2, ShoppingBag } from "lucide-react";
import { Button } from "@heroui/react";
import { useCart } from "@/hooks/useCart";
import ProductLabel from "@/components/ProductLabel";
import { Skeleton } from "@heroui/skeleton";
import { useLanguage } from "@/context/LanguageContext";

export default function WishlistPage() {
  const [wishlist, setWishlist] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const { addToCart, isAddingToCart } = useCart();
  const { t, formatPrice } = useLanguage();

  useEffect(() => {
    const savedWishlist = JSON.parse(localStorage.getItem("wishlist") || "[]");
    setWishlist(savedWishlist);

    const fetchProducts = async () => {
      try {
        const res = await fetch("/api/products");
        if (!res.ok) throw new Error("Failed to fetch products");
        const allProducts = await res.json();
        const wishlistProductIds = savedWishlist.map((item) => item.productId);
        setProducts(allProducts.filter((p) => wishlistProductIds.includes(p._id)));
      } catch (error) {
        console.error("Error loading wishlist products:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchProducts();
  }, []);

  const handleRemoveFromWishlist = (productId) => {
    const updatedWishlist = wishlist.filter((item) => item.productId !== productId);
    setWishlist(updatedWishlist);
    localStorage.setItem("wishlist", JSON.stringify(updatedWishlist));
    window.dispatchEvent(new Event("wishlistUpdated"));
  };

  const handleAddToCart = async (item) => {
    const productDetails = products.find((p) => p._id === item.productId);
    const product = {
      _id: item.productId,
      title: item.title,
      images: [item.image],
      salePrice: item.salePrice,
      regularPrice: item.regularPrice,
      currencySymbol: "MAD",
      // Admin product lock (from the live product list): the cart refuses it.
      isLocked: productDetails?.isLocked === true,
    };
    await addToCart(product);
  };

  const handleMoveToCart = async (item) => {
    try {
      await handleAddToCart(item);
    } catch (err) {
      if (err?.code === "PRODUCT_LOCKED") { alert(t("product_locked_cart")); return; } // stays in the wishlist
      throw err;
    }
    handleRemoveFromWishlist(item.productId);
  };

  const calculateDiscount = (regularPrice, salePrice) => {
    if (!salePrice || !regularPrice) return 0;
    return Math.round(((regularPrice - salePrice) / regularPrice) * 100);
  };

  const itemsLabel = (count) =>
    count === 1 ? `1 ${t("wishlist_item")}` : `${count} ${t("wishlist_items")}`;

  return (
    <div className="bg-gray-50 min-h-screen">
      <div className="container mx-auto px-4 md:px-20 py-6 md:py-12">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl md:text-3xl font-medium text-gray-900 mb-2">
            {t("wishlist_title")}
          </h1>
          {!loading && wishlist.length > 0 && (
            <p className="text-sm text-gray-600">
              {wishlist.length === 1
                ? `1 ${t("wishlist_items_saved")}`
                : `${wishlist.length} ${t("wishlist_items_saved_plural")}`}
            </p>
          )}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2">
              <div className="bg-white rounded-2xl p-6">
                <div className="space-y-4">
                  {Array.from({ length: 3 }).map((_, idx) => (
                    <div key={idx} className="flex gap-4 p-4 bg-gray-50 rounded-2xl">
                      <Skeleton className="w-20 h-20 rounded-xl" />
                      <div className="flex-1 space-y-3">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                        <Skeleton className="h-8 w-32" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="lg:col-span-1">
              <div className="bg-white rounded-2xl p-6">
                <Skeleton className="h-6 w-32 mb-4" />
                <div className="space-y-3">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-12 w-full mt-6" />
                </div>
              </div>
            </div>
          </div>
        ) : wishlist.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="bg-white rounded-3xl p-12 mb-8 shadow-sm">
              <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <Heart className="w-12 h-12 text-gray-400" />
              </div>
              <h2 className="text-xl font-medium text-gray-900 mb-3">{t("wishlist_empty")}</h2>
              <p className="text-gray-600 mb-8 max-w-md">{t("wishlist_empty_message")}</p>
              <Link href="/products">
                <Button
                  size="lg"
                  className="bg-gray-900 text-white h-12 px-8 rounded-2xl font-medium"
                  startContent={<ShoppingBag className="w-4 h-4" />}
                >
                  {t("wishlist_start_shopping")}
                </Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Wishlist Items */}
            <div className="lg:col-span-2">
              <div className="bg-white rounded-2xl p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-6">
                  {t("wishlist_saved_items")}
                </h3>
                <div className="space-y-4">
                  {wishlist.map((item) => {
                    const product = products.find((p) => p._id === item.productId);
                    const discount = calculateDiscount(item.regularPrice, item.salePrice);
                    const imageUrl = item.image || "https://placehold.co/400x500?text=No+Image";

                    return (
                      <div
                        key={item.productId}
                        className="flex gap-4 p-4 bg-gray-50 rounded-2xl hover:bg-gray-100 transition-colors"
                      >
                        {/* Product Image */}
                        <Link href={`/products/${item.productId}`} className="flex-shrink-0">
                          <div className="relative w-20 h-20 rounded-xl overflow-hidden bg-white">
                            <img
                              src={imageUrl}
                              alt={item.title}
                              className="w-full h-full object-cover hover:scale-105 transition-transform"
                            />
                            {product?.productLabel && (
                              <div className="absolute -top-1 -right-1">
                                <ProductLabel label={product.productLabel} size="xs" />
                              </div>
                            )}
                          </div>
                        </Link>

                        {/* Product Details */}
                        <div className="flex-1 min-w-0">
                          <Link href={`/products/${item.productId}`}>
                            <h4 className="text-sm font-medium text-gray-900 line-clamp-2 hover:text-gray-700 transition-colors">
                              {item.title}
                            </h4>
                          </Link>

                          <div className="flex items-center justify-between mt-3">
                            {/* Price */}
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-gray-900">
                                {formatPrice(item.salePrice || item.regularPrice)}
                              </span>
                              {item.salePrice && item.regularPrice > 0 && item.regularPrice > item.salePrice && (
                                <>
                                  <span className="text-xs line-through text-gray-400">
                                    {formatPrice(item.regularPrice)}
                                  </span>
                                  {discount > 0 && (
                                    <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">
                                      {discount}% {t("product_off_percent")}
                                    </span>
                                  )}
                                </>
                              )}
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleMoveToCart(item)}
                                disabled={isAddingToCart(item.productId)}
                                title={t("wishlist_move_to_cart")}
                                className="p-2 text-gray-900 bg-white hover:bg-gray-50 rounded-xl transition-colors disabled:opacity-50"
                              >
                                <ShoppingCart className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleRemoveFromWishlist(item.productId)}
                                title={t("wishlist_remove")}
                                className="p-2 text-red-600 hover:bg-red-50 rounded-xl transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Wishlist Summary */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-2xl p-6 sticky top-6">
                <h3 className="text-lg font-medium text-gray-900 mb-6">
                  {t("wishlist_summary")}
                </h3>

                <div className="space-y-4 mb-6">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">{t("wishlist_total_items")}</span>
                    <span className="font-medium text-gray-900">{wishlist.length}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">{t("wishlist_ready_to_purchase")}</span>
                    <span className="font-medium text-green-600">{itemsLabel(wishlist.length)}</span>
                  </div>
                </div>

                <Link href="/products">
                  <Button
                    variant="flat"
                    size="lg"
                    className="w-full bg-gray-100 text-gray-700 h-12 rounded-2xl font-medium mb-4"
                  >
                    {t("wishlist_continue_shopping")}
                  </Button>
                </Link>

                <div className="mt-6 pt-6 border-t border-gray-100">
                  <div className="flex items-start gap-3 text-sm text-gray-600">
                    <Heart className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                    <p>{t("wishlist_save_info")}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
