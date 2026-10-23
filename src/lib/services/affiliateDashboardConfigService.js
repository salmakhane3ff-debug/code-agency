/**
 * src/lib/services/affiliateDashboardConfigService.js
 * Read / partial-save of the `affiliate-dashboard` visibility toggles
 * (rules in ../affiliateDashboardConfig.js — display only).
 */

import prisma from '../prisma.js';
import { mergeSettings } from '../settingsMerge.js';
import {
  AFFILIATE_DASHBOARD_SETTING_ID,
  normalizeAffiliateDashboardConfig,
} from '../affiliateDashboardConfig.js';

export async function getAffiliateDashboardConfig({ db = prisma } = {}) {
  const row = await db.setting.findUnique({ where: { id: AFFILIATE_DASHBOARD_SETTING_ID } }).catch(() => null);
  return normalizeAffiliateDashboardConfig(row?.data);
}

/** Merges only the validated toggles sent, so the two toggles never clobber each other. */
export async function saveAffiliateDashboardConfig(patch, { db = prisma } = {}) {
  return normalizeAffiliateDashboardConfig(
    await mergeSettings(AFFILIATE_DASHBOARD_SETTING_ID, patch, { db }),
  );
}
