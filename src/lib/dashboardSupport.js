/**
 * src/lib/dashboardSupport.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure helpers of the floating "تحدث مع الدعم مباشرة" WhatsApp button shown on the Affiliate dashboard and on
 * the authenticated Recruiter pages (src/components/support/DashboardWhatsAppButton.jsx).
 *
 *   • supportRoleForPath(pathname)  'affiliate' | 'recruiter' | null — which dashboard a route belongs to
 *   • supportMessage(role)          the role's prefilled text (no account detail of any kind)
 *   • supportWhatsappUrl(number, role)  https://wa.me/<digits>?text=… or null
 *   • supportPlacement(role, dir)   the button's fixed bottom-right offsets (Tailwind classes)
 *
 * The NUMBER is never stored here: the button passes Admin → UI Control `floatingWhatsappNumber` — the same
 * number as the Homepage floating button (src/components/FloatingWhatsApp.jsx), with the same validation.
 * No React, no fetch, no "@/…" import, so scripts/dashboardWhatsApp.test.mjs can unit-test it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { isPublicRecruiterPath } from "../app/recruiter/recruiterUiState.js";

export const AFFILIATE_DASHBOARD_PATH = "/affiliate/dashboard";
export const RECRUITER_ROOT_PATH = "/recruiter";

const normPath = (pathname) => String(pathname ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
const under = (p, base) => p === base || p.startsWith(`${base}/`);

/**
 * 'affiliate' for /affiliate/dashboard and its internal pages; 'recruiter' for /recruiter and its internal pages
 * except the public (pre-login) ones — the same list as the recruiter app shell (isPublicRecruiterPath:
 * /recruiter/login); null everywhere else (affiliate login / activation, Top pages, storefront, admin, landings…).
 */
export function supportRoleForPath(pathname) {
  if (typeof pathname !== "string" || !pathname) return null;
  const p = normPath(pathname);
  if (under(p, AFFILIATE_DASHBOARD_PATH)) return "affiliate";
  if (under(p, RECRUITER_ROOT_PATH) && !isPublicRecruiterPath(p)) return "recruiter";
  return null;
}

const MESSAGES = Object.freeze({
  affiliate: "مرحباً، أنا مسوق في Ecome Agency وأحتاج إلى مساعدة.",
  recruiter: "مرحباً، أنا مُجنِّد في Ecome Agency وأحتاج إلى مساعدة.",
});

/** The prefilled WhatsApp text of a role ("" for an unknown role). Generic on purpose: no name, id, phone or token. */
export function supportMessage(role) {
  return Object.prototype.hasOwnProperty.call(MESSAGES, role) ? MESSAGES[role] : "";
}

/**
 * wa.me link to `number` (digits only — "+212 6 12-34-56-78" → 212612345678) with the role's message, or null when
 * the number has fewer than 10 digits or the role is unknown (same validation as the Homepage floating button).
 */
export function supportWhatsappUrl(number, role) {
  const message = supportMessage(role);
  if (!message) return null;
  const digits = String(number ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

// ── Placement ─────────────────────────────────────────────────────────────────
// Always the physical bottom-RIGHT corner, right: max(16px, safe-area-inset-right), in both languages. Measured from
// the elements that share that corner (both bottom navs ≈ 76px + safe area, and the pages pad 96px for them):
//   • phones (< md), default: bottom calc(96px + safe area) — above the affiliate / recruiter bottom nav;
//   • md+, default: bottom max(24px, safe area);
//   • affiliate, LTR (French): the UGC "Add video" button (UgcTab.jsx, w-16 h-16 = 64px, `end-5` = RIGHT in LTR,
//     bottom-6 on md+, calc(104px + safe area) on phones) shares the corner → stack above it with a 12px gap:
//     md+ 24 + 64 + 12 = 100px; phones 104 + 64 + 12 = calc(180px + safe area). In Arabic (RTL) its `end` side is
//     the LEFT, so the default offsets apply;
//   • recruiter, RTL (Arabic) md+: the shell's sticky full-height sidebar (RecruiterShell.jsx, md:w-60 / lg:w-64) is
//     on the RIGHT, with its help / logout entries low on short screens → stay right of the content, clear of the
//     sidebar: right calc(15rem + 16px) / lg calc(16rem + 16px). In French (LTR) the sidebar is on the left.
// Full literal class strings (Tailwind scans the source).
const PLACEMENT = Object.freeze({
  default: "right-[max(16px,env(safe-area-inset-right))] bottom-[calc(96px+env(safe-area-inset-bottom))] md:bottom-[max(24px,env(safe-area-inset-bottom))]",
  affiliateLtr: "right-[max(16px,env(safe-area-inset-right))] bottom-[calc(180px+env(safe-area-inset-bottom))] md:bottom-[100px]",
  recruiterRtl: "right-[max(16px,env(safe-area-inset-right))] md:right-[calc(15rem+16px)] lg:right-[calc(16rem+16px)] bottom-[calc(96px+env(safe-area-inset-bottom))] md:bottom-[max(24px,env(safe-area-inset-bottom))]",
});

/** Fixed-position classes of the button for a role and the market direction ('rtl' | 'ltr'); null for no role. */
export function supportPlacement(role, dir) {
  if (role === "affiliate") return dir === "ltr" ? PLACEMENT.affiliateLtr : PLACEMENT.default;
  if (role === "recruiter") return dir === "rtl" ? PLACEMENT.recruiterRtl : PLACEMENT.default;
  return null;
}
