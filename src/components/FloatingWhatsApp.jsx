"use client";

/**
 * FloatingWhatsApp
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixed WhatsApp contact button shown on public pages, controlled entirely from
 * Admin → UI Control (no hardcoded number). Renders nothing unless enabled and
 * a number is configured, and is hidden on admin/affiliate/recruiter/login/checkout pages
 * (the affiliate dashboard and the recruiter pages show their own support button,
 * src/components/support/DashboardWhatsAppButton.jsx, with this same number).
 *
 * Fixed-position → does not affect layout. Independent of the sticky cart bar
 * and the existing per-page WhatsApp links (this touches neither).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { usePathname } from "next/navigation";
import { useUIControl } from "@/hooks/useUIControl";
import { trackClarity } from "@/lib/trackClarity";

// Routes where the floating button must never appear.
const HIDDEN_PREFIXES = ["/admin", "/affiliate", "/recruiter", "/login", "/checkout"];

export default function FloatingWhatsApp() {
  const pathname = usePathname();
  const ui = useUIControl();

  // Route exclusion (public pages only).
  if (pathname && HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  if (!ui.showFloatingWhatsapp) return null;

  // Validate: digits only, and a plausible international length (>= 10 digits).
  const digits = String(ui.floatingWhatsappNumber || "").replace(/\D/g, "");
  if (digits.length < 10) return null;

  const message = ui.floatingWhatsappMessage || "";
  const href = `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ""}`;

  const isLeft = ui.floatingWhatsappPosition === "left";
  const bottom = Number.isFinite(Number(ui.floatingWhatsappBottom))
    ? Number(ui.floatingWhatsappBottom)
    : 24;

  // Mobile: sit ABOVE the sticky add-to-cart bar (bottom-28 ≈ 112px clears its
  // badge-strip + thumbnail-row height). md+: use the admin-configured offset via
  // the --fw-bottom CSS var (default 24px ≈ bottom-6). Right side, size, color,
  // animation and z-index (z-[60]) are unchanged.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Contact us on WhatsApp"
      onClick={() => trackClarity("cta_whatsapp_float", ui.floatingWhatsappPosition || "right")}
      style={{ "--fw-bottom": `${bottom}px`, [isLeft ? "left" : "right"]: "20px" }}
      className="fixed z-[60] bottom-28 md:[bottom:var(--fw-bottom)] flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg shadow-green-500/30 transition-transform duration-200 hover:scale-110 active:scale-95"
    >
      {/* Inline WhatsApp glyph — no extra dependency */}
      <svg viewBox="0 0 32 32" width="30" height="30" fill="currentColor" aria-hidden="true">
        <path d="M16.003 3.2c-7.06 0-12.79 5.73-12.79 12.79 0 2.255.59 4.463 1.71 6.41L3.2 28.8l6.57-1.72a12.74 12.74 0 0 0 6.23 1.59h.005c7.06 0 12.79-5.73 12.79-12.79 0-3.42-1.332-6.634-3.75-9.052A12.71 12.71 0 0 0 16.003 3.2zm0 23.02h-.004a10.6 10.6 0 0 1-5.4-1.48l-.387-.23-4.006 1.05 1.07-3.905-.252-.4a10.57 10.57 0 0 1-1.62-5.64c0-5.86 4.77-10.63 10.64-10.63 2.84 0 5.51 1.108 7.52 3.117a10.56 10.56 0 0 1 3.114 7.52c0 5.86-4.77 10.628-10.63 10.628zm5.83-7.96c-.32-.16-1.89-.933-2.183-1.04-.293-.106-.506-.16-.72.16-.213.32-.826 1.04-1.013 1.253-.187.213-.373.24-.693.08-.32-.16-1.35-.498-2.57-1.586-.95-.847-1.59-1.893-1.777-2.213-.187-.32-.02-.493.14-.653.144-.143.32-.373.48-.56.16-.187.213-.32.32-.533.107-.213.053-.4-.027-.56-.08-.16-.72-1.735-.986-2.375-.26-.623-.523-.54-.72-.55l-.613-.01c-.213 0-.56.08-.853.4-.293.32-1.12 1.093-1.12 2.667 0 1.573 1.146 3.093 1.306 3.307.16.213 2.256 3.443 5.466 4.827.764.33 1.36.527 1.824.674.767.244 1.464.21 2.016.127.615-.092 1.89-.773 2.157-1.52.267-.747.267-1.387.187-1.52-.08-.133-.293-.213-.613-.373z" />
      </svg>
    </a>
  );
}
