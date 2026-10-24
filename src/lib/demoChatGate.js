/**
 * src/lib/demoChatGate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The two gates of the DEMO chat (Phase 3C). The chat is shown only when BOTH:
 *   1. server env DEMO_CHAT_ENABLED === 'true'          (deploy-time switch)
 *   2. settings row "demo-chat-config" has enabled: true (protected: reserved
 *      in settingsController, so the generic /api/setting route cannot write it)
 * Phase 3C-2 ships no code that writes the settings row and no route that
 * turns the chat on, so the feature stays OFF whatever the env says.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEMO_CHAT_SETTING_ID = 'demo-chat-config';

/** Pure: evaluate the gates from their raw inputs. */
export function evaluateGates(envValue, settingData) {
  const env = envValue === 'true';
  const setting = !!(settingData && typeof settingData === 'object' && settingData.enabled === true);
  return { env, setting, enabled: env && setting };
}

/** Read both gates (db = demo DB seam). Any read failure → disabled. */
export async function readDemoChatGates(db, env = process.env) {
  let data = null;
  try {
    const row = await db.setting.findUnique({ where: { id: DEMO_CHAT_SETTING_ID } });
    data = row?.data ?? null;
  } catch {
    data = null;
  }
  return evaluateGates(env?.DEMO_CHAT_ENABLED, data);
}

export async function isDemoChatEnabled(db, env) {
  return (await readDemoChatGates(db, env)).enabled;
}
