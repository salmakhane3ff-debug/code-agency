/**
 * src/lib/controllers/settingsController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles generic settings (store / payment / integrations) and the dedicated
 * delivery-timing (order-settings) endpoint.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getSettings,
  upsertSettings,
  getDeliverySettings,
  upsertDeliverySettings,
} from '../services/settingsService.js';
import { badRequest, serverError } from '../utils/apiResponse.js';
import { REWARDS_SETTING_ID, REWARDS_RECONCILE_STATE_ID } from '../rewards.js';
import { mergeSettings } from '../settingsMerge.js';
import { AFFILIATE_DASHBOARD_SETTING_ID } from '../affiliateDashboardConfig.js';

/**
 * Settings rows that have their own service and must never be written raw:
 * 'rewards-config' is saved only through rewardsService.saveRewardsConfig,
 * which runs the launch baseline under a table lock, manages the launch
 * timestamps and writes the audit log. A raw write would bypass all three.
 * 'rewards-reconcile-state' holds reconcile's resume cursors (system-managed).
 */
const RESERVED_SETTING_TYPES = new Set([
  REWARDS_SETTING_ID, REWARDS_RECONCILE_STATE_ID,
  // Validated + merged by their dedicated admin routes
  // (/api/admin/team-bonus-config, /api/admin/affiliate-dashboard-config).
  'team-bonus-config', AFFILIATE_DASHBOARD_SETTING_ID,
]);

/**
 * Rows saved as a PARTIAL update (atomic top-level JSONB merge) instead of a
 * whole-row replace: keys the admin form does not send — e.g. the landing's
 * tracking counters written concurrently by /api/tsajlim3ana/track — are kept.
 */
const MERGE_SETTING_TYPES = new Set(['booster-packages', 'recruitment-landing']);

// ── Generic settings (/api/setting) ──────────────────────────────────────────

/**
 * GET /api/setting?type=store|payment|delivery|integrations
 * Returns the raw settings object (or {} if the row doesn't exist).
 * Mirrors old MongoDB response: the entire settings document.
 */
export async function getSettingsHandler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type') || 'store';

    const data = await getSettings(type);

    // WHY: Store/payment/delivery settings are read on almost every page load but
    // changed only occasionally by the admin. A 5-minute public cache cuts DB reads
    // dramatically under real traffic. Admin POSTs to this endpoint so writes always
    // bypass cache; the next GET after the TTL expires will fetch fresh data.
    // Types that are security-sensitive (integrations = API keys) are never cached.
    const publicTypes = new Set(['store', 'delivery', 'homepage_layout', 'ui-control',
      'discount_rules', 'conversion_optimization', 'spin_wheel_config']);
    const cacheHeader = publicTypes.has(type)
      ? 'public, max-age=300, stale-while-revalidate=60'
      : 'no-store';

    return Response.json({ ...data, _id: type }, {
      headers: { 'Cache-Control': cacheHeader },
    });
  } catch (err) {
    console.error('Settings GET error:', err);
    return serverError('Failed to fetch settings');
  }
}

/**
 * POST /api/setting?type=store|payment|delivery|integrations
 * Body: { ...settingsFields }
 * Upserts the settings row and returns { message, data }.
 */
export async function upsertSettingsHandler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type') || 'store';
    if (RESERVED_SETTING_TYPES.has(type)) {
      return badRequest('Ce paramètre se modifie uniquement depuis sa page dédiée.');
    }
    const body = await req.json();

    const saved = MERGE_SETTING_TYPES.has(type)
      ? await mergeSettings(type, body)
      : await upsertSettings(type, body);
    return Response.json({ message: 'Saved', data: { ...saved, _id: type } });
  } catch (err) {
    console.error('Settings POST error:', err);
    return serverError('Failed to save settings');
  }
}

// ── Delivery timing settings (/api/order-settings) ───────────────────────────

/**
 * GET /api/order-settings
 * Returns the delivery timing config with all timing fields at the top level.
 */
export async function getOrderSettingsHandler() {
  try {
    const data = await getDeliverySettings();
    return Response.json({ ...data, _id: 'delivery' });
  } catch (err) {
    console.error('Order Settings GET error:', err);
    return serverError('Failed to fetch order settings');
  }
}

/**
 * PUT /api/order-settings
 * Body: { dispatchAfterHours, inTransitAfterHours, outForDeliveryAfterHours,
 *         deliveredAfterHours, autoUpdateStatus }
 * Validates the timing sequence before saving.
 */
export async function updateOrderSettingsHandler(req) {
  try {
    const body = await req.json();
    const {
      dispatchAfterHours,
      inTransitAfterHours,
      outForDeliveryAfterHours,
      deliveredAfterHours,
      autoUpdateStatus,
    } = body;

    const result = await upsertDeliverySettings({
      dispatchAfterHours,
      inTransitAfterHours,
      outForDeliveryAfterHours,
      deliveredAfterHours,
      autoUpdateStatus,
    });

    if (result.error) return badRequest(result.error);
    return Response.json({ ...result, _id: 'delivery' });
  } catch (err) {
    console.error('Order Settings PUT error:', err);
    return serverError('Failed to update order settings');
  }
}

/**
 * POST /api/order-settings   (reset to defaults)
 * Deletes the current row and recreates it with factory defaults.
 */
export async function resetOrderSettingsHandler() {
  try {
    const defaults = {
      dispatchAfterHours:       24,
      inTransitAfterHours:      48,
      outForDeliveryAfterHours: 96,
      deliveredAfterHours:      120,
      autoUpdateStatus:         true,
    };

    // upsertDeliverySettings skips validation for the safe defaults
    await upsertDeliverySettings(defaults);
    return Response.json({ ...defaults, defaultSettings: true, _id: 'delivery' }, { status: 201 });
  } catch (err) {
    console.error('Order Settings POST error:', err);
    return serverError('Failed to reset order settings');
  }
}
