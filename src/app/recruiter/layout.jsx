/**
 * src/app/recruiter/layout.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Recruiter area (Affiliate Recruiter System), independent of the public store layout
 * (the store header / footer are hidden on /recruiter). It follows the visitor's MARKET —
 * the existing site-language choice (LanguageSwitcher → `store_lang`): MA → Arabic, RTL;
 * FR → French, LTR (MarketScope, src/lib/marketLocale.js).
 * Phase 2 (UI only): every authenticated recruiter page renders inside ONE app shell
 * (RecruiterAppShell — sidebar, header, drawer, bottom bar); the public login page does not.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import RecruiterAppShell from "./_components/RecruiterAppShell";
import { MarketScope } from "@/context/useMarketLocale";

export const metadata = { title: "لوحة مسؤول التوظيف · Espace recruteur", robots: { index: false, follow: false } };

export default function RecruiterLayout({ children }) {
  return (
    <MarketScope className="min-h-screen bg-slate-50 text-slate-900"
      style={{ fontFamily: "'Tajawal', 'Cairo', 'Noto Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif" }}>
      <RecruiterAppShell>{children}</RecruiterAppShell>
    </MarketScope>
  );
}
