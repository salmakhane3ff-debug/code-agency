"use client";
/**
 * src/components/affiliate/AffiliateNavGate.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The affiliate mobile bottom navigation on the Top Members / Top Brands pages and their
 * profiles (mounted by src/app/top-members/layout.jsx and src/app/top-brands/layout.jsx).
 *
 *   • Signed-in affiliates only: renders NOTHING on the server and nothing for a visitor
 *     without an affiliate session (same test as the dashboard bootstrap: token + id in
 *     localStorage). Public visitors, crawlers and the server HTML are unchanged.
 *   • The SAME component as the dashboard (MobileBottomNav): each tab opens
 *     /affiliate/dashboard?tab=<id>; "Produits" goes to /products as on the dashboard; the
 *     center button copies the referral link; "Déconnexion" clears the same session keys.
 *   • Referral link / unread badge / recharge entry come from the snapshot the dashboard keeps
 *     in sessionStorage (src/lib/affiliateNav.js), else the username saved at login.
 *   • While shown it sets <html data-affiliate-nav> so globals.css pads the page bottom on
 *     phones: nothing (content or footer) ends up hidden behind the bar.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import MobileBottomNav from "./MobileBottomNav";
import { useMarketLocale } from "@/context/useMarketLocale";
import {
  AFFILIATE_SESSION_KEYS, NAV_SNAPSHOT_KEY, dashboardTabHref, hasAffiliateSession, parseNavSnapshot, referralLink,
} from "@/lib/affiliateNav";

export const NAV_HTML_ATTR = "data-affiliate-nav";

export default function AffiliateNavGate() {
  const router = useRouter();
  const { lang, dir } = useMarketLocale(null);
  const [nav, setNav] = useState(null); // null = not an affiliate (or not mounted yet)

  useEffect(() => {
    if (!hasAffiliateSession(window.localStorage)) return;
    let raw = null;
    try { raw = window.sessionStorage.getItem(NAV_SNAPSHOT_KEY); } catch {}
    const snap = parseNavSnapshot(raw);
    let username = snap.username;
    if (!username) { try { username = window.localStorage.getItem("affiliateUsername"); } catch {} }
    setNav({ unread: snap.unread, rechargeEnabled: snap.rechargeEnabled, refLink: referralLink(window.location.origin, username) });
  }, []);

  useEffect(() => {
    if (!nav) return undefined;
    const root = document.documentElement;
    root.setAttribute(NAV_HTML_ATTR, "");
    return () => root.removeAttribute(NAV_HTML_ATTR);
  }, [nav]);

  if (!nav) return null;

  const openTab = (tab) => router.push(dashboardTabHref(tab));
  const logout = () => {
    AFFILIATE_SESSION_KEYS.forEach((k) => { try { window.localStorage.removeItem(k); } catch {} });
    try { window.sessionStorage.removeItem(NAV_SNAPSHOT_KEY); } catch {}
    router.push("/affiliate/login");
  };

  return (
    <div dir={dir} lang={lang} data-affiliate-nav-gate>
      <MobileBottomNav
        activeTab={null}
        setActiveTab={openTab}
        refLink={nav.refLink}
        onLogout={logout}
        unread={nav.unread}
        rechargeEnabled={nav.rechargeEnabled}
      />
    </div>
  );
}
