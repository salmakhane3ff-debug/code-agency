"use client";

import { useState, createContext, useContext } from 'react';
import { useDiscountRules } from '@/hooks/useDiscountRules';
import { fireFunnelEvent } from '@/components/tracking/FunnelTracker';
import { trackClarity } from '@/lib/trackClarity';
import { isProductLocked, PRODUCT_LOCKED } from '@/lib/productLock';

// Create cart context for global cart drawer state
const CartContext = createContext();

export const CartProvider = ({ children }) => {
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);

  return (
    <CartContext.Provider value={{ cartDrawerOpen, setCartDrawerOpen }}>
      {children}
    </CartContext.Provider>
  );
};

export const useCartDrawer = () => {
  const context = useContext(CartContext);
  if (!context) {
    return { cartDrawerOpen: false, setCartDrawerOpen: () => {} };
  }
  return context;
};

export const useCart = () => {
  const [addingToCart, setAddingToCart] = useState({});
  const cartDrawerContext = useCartDrawer();
  const { setCartDrawerOpen } = cartDrawerContext || { setCartDrawerOpen: () => {} };
  const { getDiscount } = useDiscountRules();

  const addToCart = (product, quantity = 1, opts = {}) => {
    return new Promise((resolve, reject) => {
      if (!product || !product._id) {
        console.error("Invalid product data:", product);
        reject(new Error("Invalid product data"));
        return;
      }
      // Admin product lock: a locked product can never enter the cart (the
      // server refuses it in createOrder too). Free gifts follow the Gift System.
      if (isProductLocked(product) && !product._isGift) {
        reject(Object.assign(new Error("Product is locked"), { code: PRODUCT_LOCKED }));
        return;
      }

      setAddingToCart((prev) => ({ ...prev, [product._id]: true }));

      setTimeout(() => {
        try {
          // Add to cart logic
          const cart = JSON.parse(localStorage.getItem("cart") || "[]");
          const existingIndex = cart.findIndex((item) => item.productId === product._id);

          // Gift items always cost 0 — skip discount rules
          const isGift = !!product._isGift;
          const discountRule = isGift ? null : getDiscount(product);
          const effectivePrice = isGift
            ? 0
            : discountRule
              ? discountRule.effectivePrice
              : parseFloat(product.salePrice || product.regularPrice || 0);

          const cartItem = {
            productId: product._id,
            title: product.title,
            quantity: quantity,
            variants: opts.variants || [],   // [{name, value}] — generic variant selections
            image: product.images?.[0]?.url || product.images?.[0] || "",
            price: effectivePrice,
            currency: product.currencySymbol || process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || "$",
            ...(isGift && { _isGift: true }),
          };

          if (existingIndex !== -1) {
            cart[existingIndex].quantity += quantity;
          } else {
            cart.push(cartItem);
          }

          localStorage.setItem("cart", JSON.stringify(cart));
          
          // Dispatch cart update event for header count
          window.dispatchEvent(new CustomEvent("cartUpdated"));

          // First-party funnel event — fires once here for every add-to-cart
          // entry point (PDP, grid, slider, wishlist). Not the Meta Pixel event.
          fireFunnelEvent({ event: "add_to_cart", productId: product._id });
          trackClarity("add_to_cart", product._id);

          setAddingToCart((prev) => ({ ...prev, [product._id]: false }));
          
          // Open cart drawer after adding item (if context is available)
          if (setCartDrawerOpen) {
            setCartDrawerOpen(true);
          }
          
          console.log("Product added to cart:", cartItem);
          resolve(cartItem);
        } catch (error) {
          console.error("Error adding to cart:", error);
          setAddingToCart((prev) => ({ ...prev, [product._id]: false }));
          reject(error);
        }
      }, 500);
    });
  };

  const isAddingToCart = (productId) => {
    return addingToCart[productId] || false;
  };

  return {
    addToCart,
    isAddingToCart,
    addingToCart
  };
};