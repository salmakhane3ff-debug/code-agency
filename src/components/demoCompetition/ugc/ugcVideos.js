/**
 * src/components/demoCompetition/ugc/ugcVideos.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure helpers of the affiliate dashboard "UGC Videos" tab — the SIMULATED Demo Competition
 * leaderboard of UGC videos (no React, no DOM: executed by scripts/demoCompUgcDashboard.test.mjs).
 *
 * The tab reads ONE public, read-only endpoint (UGC_VIDEOS_ENDPOINT, no auth, like
 * /api/demo-competition/members|brands) through the shared live poller. It never reads the real UGC
 * endpoints, orders, earnings or wallet: every figure shown is simulated.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const UGC_VIDEOS_ENDPOINT = "/api/demo-competition/ugc-videos";
/** Rows requested (the API caps it at its own maximum). */
export const UGC_VIDEOS_LIMIT = 50;
export const UGC_VIDEOS_URL = `${UGC_VIDEOS_ENDPOINT}?limit=${UGC_VIDEOS_LIMIT}`;
/** The podium (top-3 highlight) — the list shows the following ranks. */
export const UGC_PODIUM_SIZE = 3;

/** A media URL the page may load: http(s) or a same-origin path ("/…", not "//…"); anything else → null. */
export function safeMediaUrl(url) {
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (!u || u.length > 2048 || /\s/.test(u)) return null;
  if (/^https?:\/\/[^/]/i.test(u)) return u;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  return null;
}

const wholeNonNeg = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);

/**
 * API `videos` → display rows (null when not loaded yet, so live diffs never mark the first load as "new").
 * Guards: a row without a playable video URL is dropped (the API never lists one, but the UI must not
 * offer an empty player); ids are strings; counts / amounts are non-negative integers (centimes);
 * a missing rank falls back to the position. One owner may own several rows (each video ranks alone).
 */
export function normalizeUgcVideos(videos) {
  if (!Array.isArray(videos)) return [];
  const out = [];
  for (const v of videos) {
    if (!v || typeof v !== "object" || v.videoId == null) continue;
    const videoUrl = safeMediaUrl(v.videoUrl);
    if (!videoUrl) continue;
    const rank = Number.isInteger(v.rank) && v.rank > 0 ? v.rank : out.length + 1;
    const totalRewardCents = Number.isFinite(Number(v.totalRewardCents))
      ? wholeNonNeg(v.totalRewardCents)
      : wholeNonNeg(Number(v.totalReward) * 100);
    const owner = v.owner && typeof v.owner === "object" && typeof v.owner.name === "string" && v.owner.name.trim()
      ? { id: v.owner.id != null ? String(v.owner.id) : v.owner.name, name: v.owner.name, avatarUrl: safeMediaUrl(v.owner.avatarUrl) }
      : null;
    out.push({
      id: String(v.videoId),
      rank,
      title: typeof v.title === "string" ? v.title : "",
      thumbnailUrl: safeMediaUrl(v.thumbnailUrl),
      videoUrl,
      owner,
      sales: wholeNonNeg(v.sales),
      rewardPerSaleCents: wholeNonNeg(Number(v.rewardPerSale) * 100),
      totalRewardCents,
    });
  }
  return out;
}

/** { podium: the first UGC_PODIUM_SIZE rows, rest: the others } (rows already sorted by rank). */
export function splitPodium(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return { podium: list.slice(0, UGC_PODIUM_SIZE), rest: list.slice(UGC_PODIUM_SIZE) };
}

/**
 * The tab's state from the poller: 'loading' | 'error' | 'disabled' | 'empty' | 'ready'.
 * A 404 (endpoint absent) or `enabled:false` → 'disabled'; an error before any data → 'error'
 * (with data, the last values stay on screen with a "stale" notice instead).
 */
export function ugcViewState({ data, error, notFound, rows }) {
  if (notFound) return "disabled";
  if (!data) return error ? "error" : "loading";
  if (data.enabled === false) return "disabled";
  return Array.isArray(rows) && rows.length ? "ready" : "empty";
}
