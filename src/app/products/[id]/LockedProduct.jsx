"use client";

/**
 * Locked product page — shown INSTEAD of the product page when the admin has
 * locked the product. Receives only lockedProductView() data (image, name,
 * price): no description, variants, offers or buy/cart controls exist here,
 * and the full product never reaches the browser.
 */
import Link from "next/link";
import { Lock } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

export default function LockedProduct({ product }) {
  const { t, formatPrice } = useLanguage();
  const image = product.images?.[0] || "https://placehold.co/600x600?text=No+Image";
  const price = product.salePrice || product.regularPrice || 0;
  return (
    <div className="max-w-3xl mx-auto px-4 py-10" data-product-locked="true">
      <div className="bg-white rounded-3xl border !border-purple-50 p-3 md:flex gap-6 shadow-sm">
        <div className="relative md:w-1/2 aspect-square overflow-hidden rounded-2xl bg-gray-100">
          <img src={image} alt={product.title} className="absolute inset-0 w-full h-full object-cover object-top opacity-70" />
          <span className="absolute top-3 end-3 inline-flex items-center gap-1 rounded-full bg-gray-900/85 text-white text-xs font-bold px-2.5 py-1">
            <Lock className="w-3.5 h-3.5" aria-hidden="true" /> {t("product_locked")}
          </span>
        </div>
        <div className="md:w-1/2 p-3 flex flex-col gap-3">
          <h1 className="text-xl font-bold text-gray-900">{product.title}</h1>
          <p className="text-2xl font-bold text-gray-900">{formatPrice(price)}</p>
          <p className="flex items-start gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-2xl p-3">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" /> {t("product_locked_message")}
          </p>
          <Link href="/products" className="text-sm font-semibold text-purple-700 hover:underline">
            {t("product_locked_back")}
          </Link>
        </div>
      </div>
    </div>
  );
}
