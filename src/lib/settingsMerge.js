/**
 * src/lib/settingsMerge.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Race-safe PARTIAL updates of a `settings` row (JSONB `data`).
 *
 * upsertSettings() replaces the whole row: any key the caller did not send is
 * lost, and two writers that read-modify-write the same row overwrite each
 * other. These helpers instead run ONE `INSERT … ON CONFLICT DO UPDATE`
 * statement — Postgres row-locks the conflicting row for the duration of the
 * statement, so concurrent patches are applied one after the other and none is
 * lost. The merge is top-level (`data || patch`): keys absent from the patch
 * are kept, keys present are replaced as a whole (arrays/objects included).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';

const META_KEYS = new Set(['_id', 'id', 'createdAt', 'updatedAt']);

/** Plain-object patch without meta keys (same keys upsertSettings strips). */
export function cleanSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!META_KEYS.has(k) && v !== undefined) clean[k] = v;
  }
  return clean;
}

/**
 * Merge `patch` into settings row `type` (created when missing).
 * Returns the merged data object.
 */
export async function mergeSettings(type, patch, { db = prisma } = {}) {
  const clean = cleanSettingsPatch(patch);
  const rows = await db.$queryRaw`
    INSERT INTO "settings" ("id", "data", "updatedAt")
    VALUES (${type}, ${JSON.stringify(clean)}::jsonb, NOW())
    ON CONFLICT ("id") DO UPDATE SET
      "data" = (CASE WHEN jsonb_typeof("settings"."data") = 'object'
                     THEN "settings"."data" ELSE '{}'::jsonb END) || EXCLUDED."data",
      "updatedAt" = NOW()
    RETURNING "data"`;
  return rows?.[0]?.data ?? clean;
}

/**
 * Atomically add 1 to `data[group][key]` of settings row `type` (created when
 * missing), keeping every other key. Non-numeric current values restart at 1.
 */
export async function incrementSettingsCounter(type, group, key, { db = prisma } = {}) {
  await db.$executeRaw`
    INSERT INTO "settings" ("id", "data", "updatedAt")
    VALUES (${type}, jsonb_build_object(${group}::text, jsonb_build_object(${key}::text, 1)), NOW())
    ON CONFLICT ("id") DO UPDATE SET
      "data" = (CASE WHEN jsonb_typeof("settings"."data") = 'object'
                     THEN "settings"."data" ELSE '{}'::jsonb END)
        || jsonb_build_object(${group}::text,
             (CASE WHEN jsonb_typeof("settings"."data" -> ${group}::text) = 'object'
                   THEN "settings"."data" -> ${group}::text ELSE '{}'::jsonb END)
             || jsonb_build_object(${key}::text,
                  (CASE WHEN jsonb_typeof("settings"."data" -> ${group}::text -> ${key}::text) = 'number'
                        THEN ("settings"."data" -> ${group}::text ->> ${key}::text)::numeric ELSE 0 END) + 1)),
      "updatedAt" = NOW()`;
}
