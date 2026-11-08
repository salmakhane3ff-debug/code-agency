/**
 * src/app/recruiter/layout.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Recruiter area (Affiliate Recruiter System): Arabic, right-to-left, independent
 * of the public store layout (the store header / footer are hidden on /recruiter).
 * Phase 2 (UI only): every authenticated recruiter page renders inside ONE app shell
 * (RecruiterAppShell — sidebar, header, drawer, bottom bar); the public login page does not.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import RecruiterAppShell from "./_components/RecruiterAppShell";

export const metadata = { title: "لوحة مسؤول التوظيف", robots: { index: false, follow: false } };

export default function RecruiterLayout({ children }) {
  return (
    <div dir="rtl" lang="ar" className="min-h-screen bg-slate-50 text-slate-900"
      style={{ fontFamily: "'Tajawal', 'Cairo', 'Noto Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif" }}>
      <RecruiterAppShell>{children}</RecruiterAppShell>
    </div>
  );
}
