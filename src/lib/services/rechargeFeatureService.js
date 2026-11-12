/**
 * src/lib/services/rechargeFeatureService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin ON/OFF switch "Recharge de solde des Affiliés" (settings row RECHARGE_SETTING_ID in
 * the existing admin settings table). ON by default — also when the row is missing or
 * unreadable for display — so nothing changes until an admin turns it OFF.
 *
 * Scope of the switch = ONLY the affiliate balance recharge ("Dépôt de solde"):
 *   • OFF → the dashboard hides the recharge widget, the "Recharge de solde" tab / menu entry
 *     and the Booster "Recharger" shortcuts, and refuses to open the tab; the affiliate API
 *     POST /api/affiliate/deposits refuses NEW requests with 403 DEPOSIT_DISABLED
 *     (depositService.submitDeposit checks it before storing anything and again right
 *     before inserting, so a request racing the switch is not created).
 *   • It never touches existing recharge records or balances: approved top-ups stay credited
 *     (deposit_topup balance provider), the history and proofs stay readable, and the admin
 *     can still approve / reject requests submitted before the switch.
 *   • Create Your Own Brand (brand access requests, package payments, brand payment proofs) is
 *     NOT gated: it has its own routes and services (brandRouteHandlers / brandPaymentService)
 *     and only shares the private file storage module (depositStorage.js), which is not gated.
 *     Commissions, earnings, reward points / rewards wallet, withdrawals / payouts: untouched.
 *   • Turning it back ON restores everything as before (nothing was deleted or changed).
 *
 * Saves are conflict-safe (revision of the stored row, advisory transaction lock) and keep a
 * bounded history (who / when / from → to). The generic POST /api/setting refuses this type.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import prisma from '../prisma.js';
import { resolveAdminNames, nameOf } from './adminNameService.js';

export const RECHARGE_SETTING_ID = 'affiliate-recharge';
export const RECHARGE_HISTORY_MAX = 50;
const LOCK = 'affiliate-recharge-setting';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rErr = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** ON unless the stored row explicitly says enabled === false. */
export const rechargeEnabledOf = (data) => !(isPlainObject(data) && data.enabled === false);
export const rechargeRevision = (data) => createHash('sha256').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 32);

async function readRow(db) {
  const row = await db.setting.findUnique({ where: { id: RECHARGE_SETTING_ID } });
  return row ? row.data : null;
}

/** Enforcement read (new recharge requests): errors propagate — a request is never accepted on an unreadable switch. */
export async function isRechargeEnabled(db = prisma) {
  return rechargeEnabledOf(await readRow(db));
}

/** Display read (dashboard widget / tab): an unreadable switch shows the default (ON); the API still enforces. */
export async function isRechargeEnabledForDisplay(db = prisma) {
  try { return await isRechargeEnabled(db); } catch { return true; }
}

function view(data) {
  return {
    enabled: rechargeEnabledOf(data),
    isDefault: !(isPlainObject(data) && typeof data.enabled === 'boolean'),
    updatedAt: isPlainObject(data) ? data.updatedAt ?? null : null,
    updatedBy: isPlainObject(data) ? data.updatedBy ?? null : null,
    history: isPlainObject(data) && Array.isArray(data.history) ? data.history : [],
    revision: rechargeRevision(data),
  };
}

/** + display names of the admins (updatedByName, history[].byName); the stored row is unchanged. */
async function withNames(v, db) {
  const names = await resolveAdminNames([v.updatedBy, ...v.history.map((h) => h?.by)], { db });
  return { ...v, updatedByName: nameOf(names, v.updatedBy), history: v.history.map((h) => ({ ...h, byName: nameOf(names, h?.by) })) };
}

/** Admin read → { enabled, isDefault, updatedAt, updatedBy, updatedByName, history (+ byName), revision }. */
export async function getRechargeSetting({ db = prisma } = {}) {
  return withNames(view(await readRow(db)), db);
}

/**
 * Admin save { enabled: boolean, revision } → the new view.
 * @throws INVALID_INPUT (400) | SETTINGS_CONFLICT (409, with `current`) | UNAUTHORIZED (401)
 */
export async function saveRechargeSetting({ enabled, revision } = {}, { db = prisma, now = new Date(), actorId = null } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw rErr('UNAUTHORIZED', 'Administrateur non identifié.');
  if (typeof enabled !== 'boolean') throw rErr('INVALID_INPUT', 'Valeur invalide : activé ou désactivé.');
  if (typeof revision !== 'string' || !revision) throw rErr('INVALID_INPUT', 'Révision manquante.');
  const saved = await db.$transaction(async (tx) => {
    if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}::text))`;
    const current = await readRow(tx);
    if (rechargeRevision(current) !== revision) {
      throw rErr('SETTINGS_CONFLICT', 'Ce réglage a été modifié entre-temps : rechargez la page.', { current: view(current) });
    }
    const at = new Date(now).toISOString();
    const history = [
      { at, by: actorId, from: rechargeEnabledOf(current), to: enabled },
      ...(isPlainObject(current) && Array.isArray(current.history) ? current.history : []),
    ].slice(0, RECHARGE_HISTORY_MAX);
    const data = { enabled, updatedAt: at, updatedBy: actorId, history };
    const row = await tx.setting.upsert({ where: { id: RECHARGE_SETTING_ID }, update: { data }, create: { id: RECHARGE_SETTING_ID, data } });
    return view(row.data);
  }).catch(async (e) => {
    if (e?.code === 'SETTINGS_CONFLICT' && e.current) e.current = await withNames(e.current, db); // names on the conflict view too
    throw e;
  });
  return withNames(saved, db);
}

const STATUS = { INVALID_INPUT: 400, SETTINGS_CONFLICT: 409, UNAUTHORIZED: 401 };

/** Admin route bodies (GET / PUT /api/admin/affiliate-recharge); deps injectable for tests. */
export function rechargeSettingHandlers(deps = {}) {
  const { db = prisma, now = () => new Date() } = deps;
  const noStore = { 'Cache-Control': 'no-store' };
  const fail = (e) => {
    const status = STATUS[e?.code];
    if (!status) {
      console.error('[affiliate-recharge]', e?.message ?? e);
      return Response.json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' }, { status: 500, headers: noStore });
    }
    return Response.json({ error: e.message, code: e.code, ...(e.current ? { current: e.current } : {}) }, { status, headers: noStore });
  };
  const actorOf = (user) => (user?.userId ? String(user.userId) : user?.email ? String(user.email) : null);
  return {
    get: async () => {
      try { return Response.json(await getRechargeSetting({ db }), { headers: noStore }); } catch (e) { return fail(e); }
    },
    put: async (req, _ctx, user) => {
      try {
        const body = await req.json().catch(() => null);
        if (!isPlainObject(body)) throw rErr('INVALID_INPUT', 'Requête invalide.');
        return Response.json(await saveRechargeSetting({ enabled: body.enabled, revision: body.revision }, { db, now: now(), actorId: actorOf(user) }), { headers: noStore });
      } catch (e) { return fail(e); }
    },
  };
}
