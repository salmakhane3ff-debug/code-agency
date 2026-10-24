/**
 * src/lib/services/demoProfileService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin management of the DEMO competition profiles (Phase 3B) — fake personas
 * shown in the demo competition / Live Activity, never real affiliates.
 *
 * Storage (no schema change):
 *   • demo_affiliates / demo_stats         — identity + current-cycle scores
 *   • demo_earnings_history                — one row per profile per day
 *   • settings `demo-profile-meta:<id>`    — city, history-status markers and the
 *                                            reserved chat extension point (3C)
 * Every read/write goes through the demo DB seam (getDemoDb): only demo tables
 * and demo-prefixed settings rows are touched — never balances, commissions,
 * payouts or orders.
 *
 * 90-day history: the stored daily rows of the last 90 days (server-local day,
 * the same convention the simulation writes with). Nothing is generated on
 * read; the optional "backfill" fills MISSING days once, deterministically
 * (seeded by profile id + day), and marks them so they are never shown as
 * simulation-recorded or real activity.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getDemoDb, currentStandings, generateDemoAffiliates, ensureCompetition,
  invalidateDemoCache, GROWTH, COMMISSION_RATE,
} from './demoService.js';
import { CYCLE_ARCHIVE_PREFIX } from '../demoCompetitionCycle.js';
import {
  PROFILE_META_PREFIX, HISTORY_DAYS, isValidProfileId, validateProfileInput,
  validateGenerateInput, validateHistoryEdit, normalizeChatConfig,
} from '../demoProfileValidation.js';

const err = (status, code, message, field) => Object.assign(new Error(message), { status, code, field });
const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;

// Server-local midnight — the convention simulateTick/generation write with.
function localMidnight(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; }
function addLocalDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
const dayKeyOf = (date) => { const d = new Date(date); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/**
 * The 90-day window ending today: [from, to) with day keys. `today` (local
 * midnight) is where editing stops: today's row still receives simulated
 * orders, so only days strictly before it are editable.
 */
export function historyWindow(now = Date.now()) {
  const today = localMidnight(now);
  const from = addLocalDays(today, -(HISTORY_DAYS - 1));
  const to = addLocalDays(today, 1);
  return { from, to, today, fromKey: dayKeyOf(from), toKey: dayKeyOf(today) };
}

// ── Profile meta (city, status markers, chat extension point) ─────────────────
async function readMeta(db, id) {
  const row = await db.setting.findUnique({ where: { id: `${PROFILE_META_PREFIX}${id}` } });
  const d = row?.data && typeof row.data === 'object' ? row.data : {};
  return {
    city: typeof d.city === 'string' && d.city ? d.city : null,
    historyEdits: d.historyEdits && typeof d.historyEdits === 'object' ? d.historyEdits : {},
    backfilledDays: d.backfilledDays && typeof d.backfilledDays === 'object' ? d.backfilledDays : {},
    chat: normalizeChatConfig(d.chat),
  };
}
async function writeMeta(db, id, meta) {
  const data = { city: meta.city ?? null, historyEdits: meta.historyEdits || {}, backfilledDays: meta.backfilledDays || {}, chat: normalizeChatConfig(meta.chat) };
  const key = `${PROFILE_META_PREFIX}${id}`;
  await db.setting.upsert({ where: { id: key }, update: { data }, create: { id: key, data } });
}
async function metaMap(db) {
  const rows = await db.setting.findMany({ where: { id: { startsWith: PROFILE_META_PREFIX } } });
  return new Map(rows.map((r) => [r.id.slice(PROFILE_META_PREFIX.length), r.data || {}]));
}
async function archives(db) {
  const rows = await db.setting.findMany({ where: { id: { startsWith: CYCLE_ARCHIVE_PREFIX } } });
  return rows.map((r) => r.data).filter((d) => d && Number.isFinite(d.cycleNum)).sort((a, b) => b.cycleNum - a.cycleNum);
}

async function requireProfile(db, id) {
  if (!isValidProfileId(id)) throw err(400, 'INVALID_ID', 'Identifiant de profil invalide.');
  const a = await db.demoAffiliate.findUnique({ where: { id }, include: { stats: true } });
  if (!a) throw err(404, 'NOT_FOUND', 'Profil démo introuvable.');
  return a;
}

const statsView = (s) => ({
  totalOrders: s?.totalOrders ?? 0, totalRevenue: s?.totalRevenue ?? 0,
  confirmedOrders: s?.confirmedOrders ?? 0, cancelledOrders: s?.cancelledOrders ?? 0,
  todayOrders: s?.todayOrders ?? 0, todayRevenue: s?.todayRevenue ?? 0,
  teamSize: s?.teamSize ?? 0, ugcTotalSales: s?.ugcTotalSales ?? 0, ugcTotalEarnings: s?.ugcTotalEarnings ?? 0,
});
const identityView = (a, city) => ({
  id: a.id, name: a.name, username: a.username, avatarUrl: a.avatarUrl ?? null, avatarColor: a.avatarColor,
  gender: a.gender ?? null, growthType: a.growthType, isActive: a.isActive !== false, city: city ?? null,
  createdAt: a.createdAt ?? null,
});

// ── List ──────────────────────────────────────────────────────────────────────
/** All demo profiles (active + inactive) with the live rank of the single rule. */
export async function listProfiles({ q = '', status = 'all' } = {}) {
  const db = getDemoDb();
  const [rows, standings, metas, comp] = await Promise.all([
    db.demoAffiliate.findMany({ include: { stats: true } }),
    currentStandings(db),
    metaMap(db),
    ensureCompetition(),
  ]);
  const rankOf = new Map(standings.map((r) => [r.id, r.rank]));
  const needle = String(q || '').trim().toLowerCase();
  const profiles = rows
    .map((a) => ({ ...identityView(a, metas.get(a.id)?.city), rank: rankOf.get(a.id) ?? 0, stats: statsView(a.stats) }))
    .filter((p) => status === 'all' || (status === 'active' ? p.isActive : !p.isActive))
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.username.toLowerCase().includes(needle) || (p.city || '').toLowerCase().includes(needle))
    .sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity) || a.name.localeCompare(b.name));
  return {
    profiles,
    counts: { total: rows.length, active: rows.filter((a) => a.isActive !== false).length },
    cycle: { cycleNum: comp.cycleNum, startDate: comp.startDate, endDate: comp.endDate },
  };
}

// ── Detail (identity, current cycle, 90-day history, archived cycles) ─────────
export async function getProfileDetail(id, { now = Date.now() } = {}) {
  const db = getDemoDb();
  const a = await requireProfile(db, id);
  const [meta, standings, comp, arch] = await Promise.all([
    readMeta(db, id), currentStandings(db), ensureCompetition(), archives(db),
  ]);
  const win = historyWindow(now);
  const rows = await db.demoEarningsHistory.findMany({
    where: { demoAffiliateId: id, date: { gte: win.from, lt: win.to } },
    orderBy: { date: 'desc' },
  });
  const days = rows.map((h) => ({
    id: h.id,
    day: dayKeyOf(h.date),
    orders: h.orders ?? 0,
    revenue: round2(h.revenue ?? 0),
    commission: round2(h.commission ?? 0),
    // simulated = written by the demo simulation/generation; backfilled = filled
    // by the admin backfill; edited = changed by an admin. All are DEMO data.
    status: meta.historyEdits[h.id] ? 'edited' : meta.backfilledDays[dayKeyOf(h.date)] ? 'backfilled' : 'simulated',
    editable: h.date < win.today, // today's row is still being written by the simulation
  }));
  const totals = days.reduce((t, d) => ({
    days: t.days + 1, orders: t.orders + d.orders, revenue: round2(t.revenue + d.revenue), commission: round2(t.commission + d.commission),
  }), { days: 0, orders: 0, revenue: 0, commission: 0 });

  return {
    profile: identityView(a, meta.city),
    currentCycle: {
      cycleNum: comp.cycleNum, startDate: comp.startDate, endDate: comp.endDate,
      rank: standings.find((r) => r.id === id)?.rank ?? 0,
      stats: statsView(a.stats),
    },
    history: { from: win.fromKey, to: win.toKey, days, totals, timeAvailable: false },
    cycles: arch.map((c) => {
      const s = (c.standings || []).find((x) => x.demoAffiliateId === id);
      return s ? { cycleNum: c.cycleNum, startDate: c.startDate, endDate: c.endDate, reason: c.reason, rank: s.rank, totalOrders: s.totalOrders, totalRevenue: s.totalRevenue } : null;
    }).filter(Boolean),
    chat: meta.chat, // Phase 3C extension point — never enabled in 3B
    demo: true,
  };
}

// ── Create / update / delete ──────────────────────────────────────────────────
async function avatarChecker(db, current = null) {
  const lib = new Set((await db.demoAvatar.findMany({ select: { url: true } })).map((x) => x.url));
  return (url) => lib.has(url) || (current && url === current);
}
async function assertUsernameFree(db, username, selfId = null) {
  const other = await db.demoAffiliate.findUnique({ where: { username } });
  if (other && other.id !== selfId) throw err(409, 'USERNAME_TAKEN', "Ce nom d'utilisateur est déjà utilisé.", 'username');
}

export async function createProfile(input) {
  const db = getDemoDb();
  const v = validateProfileInput(input, { avatarAllowed: await avatarChecker(db) });
  if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
  const { city, isActive, ...fields } = v.value;
  await assertUsernameFree(db, fields.username);
  let a;
  try {
    a = await db.demoAffiliate.create({
      data: {
        gender: 'women', growthType: 'consistent', ...fields, isActive: isActive !== false,
        stats: { create: {} }, // a manual profile starts the current cycle at 0
      },
    });
  } catch (e) {
    if (e?.code === 'P2002') throw err(409, 'USERNAME_TAKEN', "Ce nom d'utilisateur est déjà utilisé.", 'username');
    throw e;
  }
  if (city) await writeMeta(db, a.id, { city });
  invalidateDemoCache();
  return getProfileDetail(a.id);
}

export async function updateProfile(id, input, { now = Date.now() } = {}) {
  const db = getDemoDb();
  const a = await requireProfile(db, id);
  const v = validateProfileInput(input, { partial: true, avatarAllowed: await avatarChecker(db, a.avatarUrl) });
  if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
  const { city, ...fields } = v.value;
  if (fields.username && fields.username !== a.username) await assertUsernameFree(db, fields.username, id);
  if (Object.keys(fields).length) {
    try { await db.demoAffiliate.update({ where: { id }, data: fields }); } catch (e) {
      if (e?.code === 'P2002') throw err(409, 'USERNAME_TAKEN', "Ce nom d'utilisateur est déjà utilisé.", 'username');
      throw e;
    }
  }
  if (city !== undefined) { const meta = await readMeta(db, id); await writeMeta(db, id, { ...meta, city }); }
  invalidateDemoCache();
  return getProfileDetail(id, { now });
}

const REFERENCED_MSG = "Ce profil a un historique (gains ou cycles archivés) : désactivez-le au lieu de le supprimer.";

/**
 * Permanent deletion ONLY when nothing references the profile (no earnings
 * history, absent from every archived cycle). Otherwise 409 → deactivate instead.
 *
 * Atomic: the profile row is locked (FOR UPDATE), the references are checked
 * and stats + meta + profile are deleted in ONE transaction. A simulation tick
 * that adds history concurrently either waits for the lock or makes the final
 * delete fail its RESTRICT foreign key — the transaction then rolls back, so the
 * profile can never be left half-deleted (without stats or meta).
 */
export async function deleteProfile(id) {
  const db = getDemoDb();
  await requireProfile(db, id); // 400 / 404 before opening a transaction
  try {
    await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "demo_affiliates" WHERE "id" = ${id} FOR UPDATE`;
      if (!locked?.length) throw err(404, 'NOT_FOUND', 'Profil démo introuvable.');
      const historyRows = await tx.demoEarningsHistory.count({ where: { demoAffiliateId: id } });
      const inArchive = (await archives(tx)).some((c) => (c.standings || []).some((s) => s.demoAffiliateId === id));
      if (historyRows > 0 || inArchive) throw err(409, 'PROFILE_REFERENCED', REFERENCED_MSG);
      await tx.demoStats.deleteMany({ where: { demoAffiliateId: id } });
      await tx.setting.deleteMany({ where: { id: `${PROFILE_META_PREFIX}${id}` } }); // exact id only
      await tx.demoAffiliate.delete({ where: { id } });
    });
  } catch (e) {
    // P2003 = foreign key (history written meanwhile); P2025 = deleted meanwhile.
    if (e?.code === 'P2003') throw err(409, 'PROFILE_REFERENCED', REFERENCED_MSG);
    if (e?.code === 'P2025') throw err(404, 'NOT_FOUND', 'Profil démo introuvable.');
    throw e;
  }
  invalidateDemoCache();
  return { deleted: true, id };
}

/** Batch generation: 'target' = ensure N active, 'add' = N more (reactivates hidden first). */
export async function generateProfiles(input) {
  const db = getDemoDb();
  const v = validateGenerateInput(input);
  if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
  const active = await db.demoAffiliate.count({ where: { isActive: true } });
  const target = v.value.strategy === 'add' ? active + v.value.count : v.value.count;
  const res = await generateDemoAffiliates(target, v.value.mode);
  return { ...res, target, strategy: v.value.strategy };
}

// ── History: deterministic backfill + validated edits ─────────────────────────
function seededRandom(seedText) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let a = h;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Deterministic demo figures for (profile, day): same inputs → same numbers. */
export function seededDemoDay(profileId, dayKey, growthType) {
  const g = GROWTH[growthType] || GROWTH.consistent;
  const rnd = seededRandom(`${profileId}|${dayKey}`);
  const orders = g.ordersRange[0] + Math.floor(rnd() * (g.ordersRange[1] - g.ordersRange[0] + 1));
  let revenue = 0;
  for (let i = 0; i < orders; i++) revenue += g.revenuePerOrder[0] + rnd() * (g.revenuePerOrder[1] - g.revenuePerOrder[0]);
  revenue = round2(revenue);
  return { orders, revenue, commission: round2(revenue * COMMISSION_RATE) };
}

/**
 * Fill the days of the 90-day window that have NO row — days BEFORE today only
 * (today belongs to the live simulation, which keeps adding to today's row).
 * Idempotent and deterministic.
 */
export async function backfillHistory(id, { now = Date.now() } = {}) {
  const db = getDemoDb();
  const a = await requireProfile(db, id);
  const win = historyWindow(now);
  const rows = await db.demoEarningsHistory.findMany({ where: { demoAffiliateId: id, date: { gte: win.from, lt: win.to } } });
  const have = new Set(rows.map((r) => dayKeyOf(r.date)));
  const meta = await readMeta(db, id);
  let created = 0;
  for (let i = 0; i < HISTORY_DAYS - 1; i++) { // from = today − 89 … yesterday
    const date = addLocalDays(win.from, i);
    const key = dayKeyOf(date);
    if (have.has(key)) continue;
    await db.demoEarningsHistory.create({ data: { demoAffiliateId: id, date, ...seededDemoDay(id, key, a.growthType) } });
    meta.backfilledDays[key] = true;
    created++;
  }
  if (created) await writeMeta(db, id, meta);
  return { created, existing: have.size };
}

/**
 * Edit one history entry of the 90-day window, days BEFORE today only (today's
 * row keeps receiving simulated orders, which would make an edit misleading).
 * Commission = revenue × 5 %.
 */
export async function editHistoryEntry(id, input, { now = Date.now() } = {}) {
  const db = getDemoDb();
  await requireProfile(db, id);
  const v = validateHistoryEdit(input);
  if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
  const win = historyWindow(now);
  const row = await db.demoEarningsHistory.findFirst({ where: { id: v.value.historyId, demoAffiliateId: id } });
  if (!row) throw err(404, 'NOT_FOUND', 'Entrée introuvable pour ce profil.', 'historyId');
  if (!(row.date >= win.from && row.date < win.to)) throw err(400, 'VALIDATION', 'Seules les entrées des 90 derniers jours sont modifiables.', 'historyId');
  if (!(row.date < win.today)) throw err(400, 'TODAY_LOCKED', "L'entrée du jour n'est pas modifiable : la simulation y ajoute encore des commandes. Modifiable à partir de demain.", 'historyId');
  await db.demoEarningsHistory.update({
    where: { id: row.id },
    data: { orders: v.value.orders, revenue: v.value.revenue, commission: round2(v.value.revenue * COMMISSION_RATE) },
  });
  const meta = await readMeta(db, id);
  meta.historyEdits[row.id] = new Date(now).toISOString();
  await writeMeta(db, id, meta);
  return getProfileDetail(id, { now });
}
