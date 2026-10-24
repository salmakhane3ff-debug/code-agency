/**
 * src/lib/services/demoChatFeedService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate-facing Mini Chat feed (Phase 3C-7) — READ ONLY.
 *
 *   • Journeys are assigned to DEMO profiles (one assignment per profile), never
 *     to real affiliates. The feed is therefore the same for every viewer and
 *     the server alone decides which conversations it contains: enabled
 *     assignments of ACTIVE demo profiles. No profile / assignment id is ever
 *     accepted from the client.
 *   • Messages come from the Phase 3C-6 stored view (listAssignmentMessages):
 *     current revision + current cycle, scheduledAt ≤ now, original Casablanca
 *     date/time, earnings rendered from the stored snapshot only.
 *   • Lazy materialization (approved in Phase 3C-7): with `materialize: true`
 *     (the affiliate route, only after auth + active account + both gates),
 *     each conversation of THIS feed first gets its due messages created by
 *     the Phase 3C-6 idempotent service (INSERT … ON CONFLICT DO NOTHING under
 *     the assignment FOR SHARE lock) — concurrent requests cannot duplicate a
 *     message. Bounded: at most FEED_MAX_PROFILES conversations, sequential,
 *     within MATERIALIZE_BUDGET_MS of wall time; a failure is logged and the
 *     stored messages are still shown. No scheduler, no viewer state.
 *     Without the flag the feed is read only. Demo chat tables + demo
 *     profiles (+ demo history/coverage reads for earnings snapshots) only.
 *   • Both gates off (env DEMO_CHAT_ENABLED + protected setting) → `null`;
 *     the route turns that into a uniform 404 with no chat data.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getDemoDb } from './demoService.js';
import { listAssignmentMessages, materializeAssignment } from './demoChatMessageService.js';
import { readDemoChatGates } from '../demoChatGate.js';
import { CHAT_TIMEZONE, localParts } from '../demoChatTime.js';

export const FEED_MAX_PROFILES = 20;
export const FEED_MAX_MESSAGES = 200;
export const FEED_LOCALES = Object.freeze(['ar', 'fr']);
export const MATERIALIZE_BUDGET_MS = 4000;

const MEDIA_TYPES = { image: 'image', audio: 'audio' };

/** Only http(s) or same-origin paths are ever sent to the browser. */
export function safeMediaUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 2048) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/** Public shape of an asset (no storage key, hash or uploader). */
function publicMedia(asset, type) {
  if (!asset || asset.kind !== MEDIA_TYPES[type]) return null;
  const url = safeMediaUrl(asset.url);
  if (!url) return null;
  return type === 'image'
    ? { kind: 'image', url, mimeType: asset.mimeType, width: finite(asset.width), height: finite(asset.height) }
    : { kind: 'audio', url, mimeType: asset.mimeType, durationSec: finite(asset.durationSec) };
}

/**
 * The Mini Chat feed at `now`, or null when the feature is disabled.
 * → { simulated, generatedAt, timezone, today, locale, profiles, messages, truncated }
 */
export async function getMiniChatFeed({
  now = Date.now(), locale = 'ar', env = process.env, db = getDemoDb(),
  materialize = false, clock = Date.now,
} = {}) {
  const gates = await readDemoChatGates(db, env);
  if (!gates.enabled) return null;
  const L = FEED_LOCALES.includes(locale) ? locale : 'ar';

  const assignments = await db.demoChatAssignment.findMany({
    where: { enabled: true, demoAffiliate: { isActive: true } },
    select: {
      id: true,
      demoAffiliate: { select: { id: true, name: true, avatarUrl: true, avatarColor: true, isActive: true } },
    },
    orderBy: [{ enabledAt: 'asc' }, { id: 'asc' }],
    take: FEED_MAX_PROFILES,
  });

  const profiles = [];
  const merged = [];
  const startedAt = clock();
  for (const a of assignments) {
    const p = a.demoAffiliate;
    if (!p || p.isActive !== true) continue; // defence in depth
    if (materialize && clock() - startedAt < MATERIALIZE_BUDGET_MS) {
      try {
        // Re-checks both gates and assignment.enabled itself; due messages only.
        await materializeAssignment(a.id, { now, env, db });
      } catch (e) {
        console.error('[demo-chat feed] materialization failed, showing stored messages:', { assignmentId: a.id, code: e?.code || 'ERROR' });
      }
    }
    let view;
    try {
      view = await listAssignmentMessages(a.id, { now, locale: L, db });
    } catch (e) {
      console.error('[demo-chat feed] conversation skipped:', { assignmentId: a.id, code: e?.code || 'ERROR' });
      continue; // one broken conversation never hides the others
    }
    const key = `c${profiles.length + 1}`; // opaque, per response — no database id leaves the server
    profiles.push({ key, name: p.name, avatarUrl: safeMediaUrl(p.avatarUrl), avatarColor: p.avatarColor || '#6366f1' });
    view.messages.forEach((m, i) => merged.push({ m, key, order: merged.length, i }));
  }

  // One timeline: original instants, ties keep each conversation's own order.
  merged.sort((x, y) => Date.parse(x.m.scheduledAt) - Date.parse(y.m.scheduledAt) || x.order - y.order);
  const truncated = merged.length > FEED_MAX_MESSAGES;
  const page = truncated ? merged.slice(-FEED_MAX_MESSAGES) : merged;

  const assetIds = [...new Set(page.map(({ m }) => m.assetId).filter(Boolean))];
  const assets = assetIds.length
    ? await db.demoChatAsset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, kind: true, url: true, mimeType: true, width: true, height: true, durationSec: true },
    })
    : [];
  const byId = new Map(assets.map((x) => [x.id, x]));

  const messages = page.map(({ m, key }) => {
    const at = Date.parse(m.scheduledAt);
    const local = localParts(at, CHAT_TIMEZONE);
    const out = {
      id: m.id, profile: key, type: m.type, simulated: true,
      scheduledAt: m.scheduledAt, localDate: local.date, localTime: local.time,
      text: m.text ?? null,
    };
    if (m.type === 'image' || m.type === 'audio') {
      out.media = publicMedia(byId.get(m.assetId), m.type);
      out.state = out.media ? 'ok' : 'media_unavailable';
    } else if (m.type === 'earnings') {
      // Server-rendered from the stored snapshot; anything not ok/provisional
      // carries the "unavailable" sentence, never an amount.
      out.state = m.state === 'ok' || m.state === 'provisional' ? m.state : 'unavailable';
      out.earningsPeriod = m.earningsPeriod ?? null;
      out.metricLabel = out.state === 'unavailable' ? null : (m.metricLabel ?? null);
    } else {
      out.state = 'ok';
    }
    return out;
  });

  return {
    simulated: true, generatedAt: new Date(now).toISOString(), timezone: CHAT_TIMEZONE, today: localParts(now, CHAT_TIMEZONE).date,
    locale: L, profiles, messages, truncated,
  };
}
