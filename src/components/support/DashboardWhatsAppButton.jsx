"use client";

/**
 * DashboardWhatsAppButton
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE floating "تحدث مع الدعم مباشرة" WhatsApp button for the Affiliate dashboard (/affiliate/dashboard/**) and the
 * authenticated Recruiter pages (/recruiter/** except /recruiter/login). Mounted once by src/app/affiliate/layout.jsx
 * and once by src/app/recruiter/layout.jsx (inside RecruiterAppShell); the route decides the role (src/lib/dashboardSupport.js), anywhere else it
 * renders nothing.
 *
 * Number: Admin → UI Control `floatingWhatsappNumber` (useUIControl — the root UIControlProvider, GET /api/ui-control),
 * i.e. the SAME number as the Homepage floating button. Nothing is hardcoded; while the settings load, or when no
 * valid number (≥ 10 digits) is configured, nothing is rendered (also keeps SSR and the first client render equal).
 * The prefilled text only says the role — no username, id, phone or token.
 *
 * Shown only to a signed-in user (never to a logged-out visitor before the page redirects to its login):
 *   • affiliate: the same client-side test as AffiliateNavGate — hasAffiliateSession(localStorage) (token + id),
 *     evaluated after mount and again on every navigation (the layout persists across login / logout);
 *   • recruiter: the recruiter app shell's own session state — passed in as `recruiterSignedIn` by the thin
 *     RecruiterWhatsAppButton wrapper (useRecruiterSession().me, set once the shell's GET /api/recruiter/me
 *     succeeded — no extra request). The wrapper keeps the recruiter shell out of the affiliate bundle; the
 *     recruiter layout mounts it INSIDE RecruiterAppShell (outside it / on /recruiter/login the session is null).
 *
 * Placement: always the physical BOTTOM-RIGHT corner (src/lib/dashboardSupport.js supportPlacement — the offsets
 * per role / direction / breakpoint and why). z-[45]: above the page, the sticky headers (z-20) and the UGC
 * "Add video" button (z-40); below the recruiter guide dialog (z-50), both bottom navs (z-60) and every dashboard
 * modal / sheet / toast (z-65+).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useUIControl } from "@/hooks/useUIControl";
import { useMarketLocale } from "@/context/useMarketLocale";
import { hasAffiliateSession } from "@/lib/affiliateNav";
import { supportPlacement, supportRoleForPath, supportWhatsappUrl } from "@/lib/dashboardSupport";

const LABEL = "تحدث مع الدعم مباشرة";

export default function DashboardWhatsAppButton({ recruiterSignedIn = false }) {
  const pathname = usePathname();
  const ui = useUIControl();
  const { dir } = useMarketLocale(null);
  const role = supportRoleForPath(pathname);

  // Affiliate session: browser storage only exists after mount (server HTML + first render: nothing).
  const [affiliateSignedIn, setAffiliateSignedIn] = useState(false);
  useEffect(() => {
    setAffiliateSignedIn(role === "affiliate" && hasAffiliateSession(window.localStorage));
  }, [role, pathname]);

  if (!role) return null;
  const signedIn = role === "affiliate" ? affiliateSignedIn : recruiterSignedIn === true;
  if (!signedIn) return null;
  const href = supportWhatsappUrl(ui.floatingWhatsappNumber, role);
  if (!href) return null;

  return (
    <div className={`fixed z-[45] ${supportPlacement(role, dir)}`} data-dashboard-whatsapp-dir={dir}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        dir="rtl"
        lang="ar"
        aria-label={LABEL}
        data-dashboard-whatsapp={role}
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[#25D366] ps-3 pe-4 py-2 text-sm font-bold text-white shadow-lg shadow-black/15 transition-colors hover:bg-[#1FB855] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366] focus-visible:ring-offset-2 max-[359px]:text-xs"
      >
        {/* Official WhatsApp glyph — the same inline SVG as the Homepage floating button */}
        <svg viewBox="0 0 32 32" width="22" height="22" fill="currentColor" aria-hidden="true" className="shrink-0">
          <path d="M16.003 3.2c-7.06 0-12.79 5.73-12.79 12.79 0 2.255.59 4.463 1.71 6.41L3.2 28.8l6.57-1.72a12.74 12.74 0 0 0 6.23 1.59h.005c7.06 0 12.79-5.73 12.79-12.79 0-3.42-1.332-6.634-3.75-9.052A12.71 12.71 0 0 0 16.003 3.2zm0 23.02h-.004a10.6 10.6 0 0 1-5.4-1.48l-.387-.23-4.006 1.05 1.07-3.905-.252-.4a10.57 10.57 0 0 1-1.62-5.64c0-5.86 4.77-10.63 10.64-10.63 2.84 0 5.51 1.108 7.52 3.117a10.56 10.56 0 0 1 3.114 7.52c0 5.86-4.77 10.628-10.63 10.628zm5.83-7.96c-.32-.16-1.89-.933-2.183-1.04-.293-.106-.506-.16-.72.16-.213.32-.826 1.04-1.013 1.253-.187.213-.373.24-.693.08-.32-.16-1.35-.498-2.57-1.586-.95-.847-1.59-1.893-1.777-2.213-.187-.32-.02-.493.14-.653.144-.143.32-.373.48-.56.16-.187.213-.32.32-.533.107-.213.053-.4-.027-.56-.08-.16-.72-1.735-.986-2.375-.26-.623-.523-.54-.72-.55l-.613-.01c-.213 0-.56.08-.853.4-.293.32-1.12 1.093-1.12 2.667 0 1.573 1.146 3.093 1.306 3.307.16.213 2.256 3.443 5.466 4.827.764.33 1.36.527 1.824.674.767.244 1.464.21 2.016.127.615-.092 1.89-.773 2.157-1.52.267-.747.267-1.387.187-1.52-.08-.133-.293-.213-.613-.373z" />
        </svg>
        <span className="whitespace-nowrap">{LABEL}</span>
      </a>
    </div>
  );
}
