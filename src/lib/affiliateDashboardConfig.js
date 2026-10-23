/**
 * src/lib/affiliateDashboardConfig.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin visibility toggles for the affiliate dashboard (settings row
 * `affiliate-dashboard`). PRESENTATION ONLY: they hide the overview card /
 * widget, the dashboard tab and the mobile-nav entry. They never gate an API,
 * an eligibility rule or a balance — the deposit and booster endpoints (and
 * the booster `enabled` switch in `booster-packages`) behave exactly as before.
 *
 *   depositBarEnabled  "💰 Dépôt de solde" card + tab + mobile entry
 *   boosterBarEnabled  "🚀 Booster" widget + tab + mobile entry
 *
 * Both default to visible; only an explicit `false` hides.
 * Pure (client-safe); DB access lives in services/affiliateDashboardConfigService.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const AFFILIATE_DASHBOARD_SETTING_ID = 'affiliate-dashboard';

export const AFFILIATE_DASHBOARD_TOGGLES = ['depositBarEnabled', 'boosterBarEnabled'];

export const DEFAULT_AFFILIATE_DASHBOARD_CONFIG = Object.freeze({
  depositBarEnabled: true,
  boosterBarEnabled: true,
});

export function normalizeAffiliateDashboardConfig(raw) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    depositBarEnabled: d.depositBarEnabled !== false,
    boosterBarEnabled: d.boosterBarEnabled !== false,
  };
}

/** Dashboard tab ids hidden by the toggles (tabs list, mobile nav, tab render). */
export function hiddenDashboardTabs(raw) {
  const c = normalizeAffiliateDashboardConfig(raw);
  return [
    ...(c.depositBarEnabled ? [] : ['deposit']),
    ...(c.boosterBarEnabled ? [] : ['booster']),
  ];
}

/**
 * Partial update: only the toggles present are saved (each admin toggle saves
 * on its own). Returns { ok: true, patch } or { ok: false, error }.
 */
export function validateAffiliateDashboardPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Données invalides' };
  }
  const patch = {};
  for (const key of AFFILIATE_DASHBOARD_TOGGLES) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') {
      return { ok: false, error: `${key} doit être true ou false.` };
    }
    patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'Aucun réglage à enregistrer.' };
  }
  return { ok: true, patch };
}
