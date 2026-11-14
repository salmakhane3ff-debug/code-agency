/**
 * src/lib/affiliateNav.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure helpers shared by the affiliate mobile bottom navigation on the dashboard and on the
 * Top Members / Top Brands pages (src/components/affiliate/AffiliateNavGate.jsx):
 *   • the dashboard tabs a link may open (`/affiliate/dashboard?tab=<id>`), whitelisted;
 *   • the browser-storage keys of an affiliate session (set by the affiliate login page);
 *   • a small per-tab snapshot (sessionStorage) the dashboard writes so the nav shown outside
 *     the dashboard keeps the same referral link, unread badge and recharge entry.
 * No secret is stored in the snapshot (no token): only what the nav already displays.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Every tab of the affiliate dashboard (desktop tab bar + More sheet + the overview-only booster). */
export const DASHBOARD_TABS = Object.freeze([
  'overview', 'orders', 'bank', 'payout', 'deposit', 'brand', 'rewards', 'ugc', 'notifications', 'team', 'settings', 'booster',
]);
export const DASHBOARD_PATH = '/affiliate/dashboard';

/** `?tab=` of a location search string → a known tab id, or null. */
export function parseDashboardTab(search) {
  if (typeof search !== 'string' || !search) return null;
  let tab = null;
  try { tab = new URLSearchParams(search).get('tab'); } catch { return null; }
  return tab && DASHBOARD_TABS.includes(tab) ? tab : null;
}

/** The dashboard URL that opens `tab` (overview / unknown → the plain dashboard). */
export function dashboardTabHref(tab) {
  return tab && tab !== 'overview' && DASHBOARD_TABS.includes(tab) ? `${DASHBOARD_PATH}?tab=${tab}` : DASHBOARD_PATH;
}

/** localStorage keys of an affiliate session (written by src/app/affiliate/login/page.jsx). */
export const AFFILIATE_SESSION_KEYS = Object.freeze(['affiliateToken', 'affiliateId', 'affiliateUsername', 'affiliateName']);

/** True when this browser holds an affiliate session (token + id), the same test as the dashboard bootstrap. */
export function hasAffiliateSession(storage) {
  try { return !!(storage?.getItem('affiliateToken') && storage?.getItem('affiliateId')); } catch { return false; }
}

/** The referral link the nav's center button copies (same format as the dashboard). */
export const referralLink = (origin, username) => (origin && username ? `${origin}?ref=${username}` : '');

export const NAV_SNAPSHOT_KEY = 'affiliateNavSnapshot';

/** { unread: int ≥ 0, rechargeEnabled: bool, username: string|null } from a stored JSON (defaults when missing / invalid). */
export function parseNavSnapshot(raw) {
  let s = null;
  try { s = raw ? JSON.parse(raw) : null; } catch { s = null; }
  const unread = Number.isInteger(s?.unread) && s.unread > 0 ? Math.min(s.unread, 999) : 0;
  const username = typeof s?.username === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s.username) ? s.username : null;
  return { unread, rechargeEnabled: s?.rechargeEnabled !== false, username };
}

/** The JSON the dashboard stores (only what the nav shows). */
export const serializeNavSnapshot = ({ unread = 0, rechargeEnabled = true, username = null } = {}) =>
  JSON.stringify({ unread: Math.max(0, unread | 0), rechargeEnabled: rechargeEnabled !== false, username: username || null });
