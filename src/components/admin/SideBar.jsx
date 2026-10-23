"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import {
  Home,
  Tags,
  Tag,
  Copy,
  Plus,
  LayoutGrid,
  CreditCard,
  ShieldCheck,
  FileText,
  ShoppingCart,
  Menu,
  Layers,
  Mail,
  BarChart2,
  Settings,
  GalleryHorizontalEnd,
  LogOut,
  Video,
  Wallet,
  Code,
  HelpCircle,
  Type,
  PenTool,
  BookOpen,
  Files,
  Hash,
  User,
  LayoutDashboard,
  Users,
  MousePointerClick,
  Activity,
  MessageSquare,
  Star,
  UserCheck,
  Receipt,
  Truck,
  Building2,
  ToggleRight,
  Link2,
  Disc,
  Droplets,
  Languages,
  TrendingUp,
  Gift,
  LoaderCircle,
  Film,
} from "lucide-react";

const SideBar = ({ onItemClick }) => {
  const pathname = usePathname();
  const router = useRouter();

  const links = [
    { href: "/admin", icon: <Home size={16} />, label: "Dashboard" },
    { href: "/admin/dashboard", icon: <LayoutDashboard size={16} />, label: "Growth Overview" },
    { href: "/admin/products", icon: <Tags size={16} />, label: "Products" },
    { href: "/admin/products/new", icon: <Plus size={16} />, label: "Add Product" },
    { href: "/admin/duplicates", icon: <Copy size={16} />, label: "Duplicate Listings" },
    { href: "/admin/collection", icon: <LayoutGrid size={16} />, label: "Collections" },
    { href: "/admin/blog", icon: <BookOpen size={16} />, label: "Blog Posts" },
    { href: "/admin/blog/new", icon: <PenTool size={16} />, label: "Add Blog Post" },
    { href: "/admin/pages", icon: <Files size={16} />, label: "Pages" },
    { href: "/admin/pages/new", icon: <FileText size={16} />, label: "Add Page" },
    { href: "/admin/orders", icon: <ShoppingCart size={16} />, label: "Orders" },
    { href: "/admin/abandoned-orders", icon: <ShoppingCart size={16} />, label: "Abandoned Orders" },
    { href: "/admin/whatsapp-bot", icon: <MessageSquare size={16} />, label: "WhatsApp Bot" },
    // { href: "/admin/payment", icon: <CreditCard size={16} />, label: "Payments" },
    { href: "/admin/contact", icon: <Mail size={16} />, label: "Contact" },
    { href: "/admin/faqs", icon: <HelpCircle size={16} />, label: "FAQs" },
    { href: "/admin/analytics",         icon: <BarChart2 size={16} />, label: "Analytics" },
    { href: "/admin/product-analytics", icon: <BarChart2 size={16} />, label: "Product Analytics" },
    { href: "/admin/tracker",    icon: <MousePointerClick size={16} />, label: "Click Tracker" },
    { href: "/admin/campaigns",  icon: <Link2 size={16} />,            label: "Campaigns" },
    { href: "/admin/ui-control",  icon: <ToggleRight    size={16} />, label: "UI Control" },
    { href: "/admin/preloader",  icon: <LoaderCircle  size={16} />, label: "Preloader" },
    { href: "/admin/conversion-optimization", icon: <TrendingUp size={16} />, label: "Conversion Optimization" },
    { href: "/admin/affiliates", icon: <Users size={16} />, label: "Affiliates" },
    { href: "/admin/demo-profiles", icon: <Users size={16} />, label: "🎭 Profils démo" },
    { href: "/admin/promo", icon: <Tag size={16} />, label: "Promo Codes" },
    { href: "/admin/spin-wheel", icon: <Disc size={16} />, label: "Spin Wheel" },
    { href: "/admin/gifts", icon: <Gift size={16} />, label: "Gift System" },
    { href: "/admin/rewards", icon: <Gift size={16} />, label: "🎁 Récompenses affiliés" },
    { href: "/admin/affiliate-orders", icon: <ShoppingCart size={16} />, label: "Affiliate Orders" },
    { href: "/admin/affiliate-payouts",    icon: <CreditCard size={16} />,        label: "Affiliate Payouts" },
    { href: "/admin/identity",             icon: <ShieldCheck size={16} />,       label: "Identity Verification" },
    { href: "/admin/deposits",             icon: <CreditCard size={16} />,        label: "💰 Dépôts de solde" },
    { href: "/admin/ugc-videos",           icon: <Film size={16} />,              label: "UGC Videos" },
    { href: "/admin/ugc-settings",         icon: <Settings size={16} />,          label: "UGC Settings" },
    { href: "/admin/shipping-companies",   icon: <Truck size={16} />,             label: "Shipping Companies" },
    { href: "/admin/bank-settings",        icon: <Building2 size={16} />,         label: "Bank Settings" },
    { href: "/admin/landing-pages",        icon: <MousePointerClick size={16} />, label: "Landing Pages" },
    { href: "/admin/feedback", icon: <MessageSquare size={16} />, label: "Feedback" },
    { href: "/admin/feedback-settings", icon: <Star size={16} />, label: "Feedback Settings" },
    { href: "/admin/images", icon: <GalleryHorizontalEnd size={16} />, label: "Media" },
    { href: "/admin/watermark", icon: <Droplets size={16} />, label: "Media Watermark" },
    { href: "/admin/homepage-builder",    icon: <LayoutGrid size={16} />, label: "Homepage Builder" },
    { href: "/admin/discount-management", icon: <Tag size={16} />,        label: "Discount Management" },
    { href: "/admin/slider", icon: <Layers size={16} />, label: "Sliders" },
    { href: "/admin/promo-text", icon: <Type size={16} />, label: "Promo Texts" },
    { href: "/admin/reel", icon: <Video size={16} />, label: "Reels" },
    { href: "/admin/menu", icon: <Menu size={16} />, label: "Menus" },
    { href: "/admin/support-benefits", icon: <FileText size={16} />, label: "Support Benefits" },
    { href: "/admin/news-latter", icon: <Mail size={16} />, label: "Newsletter" },
    { href: "/admin/data-hashing", icon: <Hash size={16} />, label: "Data Hashing" },
    { href: "/admin/language", icon: <Languages size={16} />, label: "Language & Localization" },
    { href: "/admin/settings", icon: <Settings size={16} />, label: "Store Settings" },
    { href: "/admin/payment-gateway", icon: <Wallet size={16} />, label: "Payment Gateway" },
    { href: "/admin/app-integrations", icon: <Code size={16} />, label: "App Integrations" },
    { href: "/admin/profile", icon: <User size={16} />, label: "Admin Profile" },
  ];

  const handleLogout = async () => {
    await fetch("/api/logout", { method: "DELETE" });
    router.push("/login");
    if (onItemClick) onItemClick(); // Close mobile sidebar
  };

  const handleLinkClick = () => {
    if (onItemClick) onItemClick(); // Close mobile sidebar when navigating
  };

  return (
    <div className="flex flex-col h-full bg-gray-50/50">
      {/* Navigation Links */}
      <nav className="flex-1 p-3 space-y-2 overflow-y-auto">
        {links.map(({ href, icon, label }) => {
          const isActive = pathname === href;
          return (
            <Link key={href} href={href} onClick={handleLinkClick}>
              <div
                className={`group mb-2 flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200 ${
                  isActive ? "bg-blue-600 text-white shadow-sm" : "text-gray-600 hover:bg-white hover:text-gray-900 hover:shadow-sm"
                }`}
              >
                <span className={`transition-colors ${isActive ? "text-white" : "text-gray-400 group-hover:text-gray-600"}`}>{icon}</span>
                <span className="truncate">{label}</span>
                {isActive && <div className="ml-auto w-1.5 h-1.5 bg-white rounded-full opacity-70"></div>}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Logout Section */}
      <div className="p-3 border-t border-gray-100">
        <button
          onClick={handleLogout}
          className="group flex items-center gap-3 w-full px-3 py-2.5 text-sm font-medium text-gray-600 rounded-xl hover:bg-red-50 hover:text-red-600 transition-all duration-200"
        >
          <LogOut size={16} className="text-gray-400 group-hover:text-red-500 transition-colors" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
};

export default SideBar;
