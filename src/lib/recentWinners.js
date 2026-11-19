/**
 * src/lib/recentWinners.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Recent Winners" (الفائزون مؤخراً) of the affiliate Rewards / Gifts page — pure rules,
 * shared by the server (src/lib/services/recentWinnersService.js) and the browser
 * (src/components/rewards/RecentWinners.jsx). No I/O, no React.
 *
 * Two SEPARATE sources, merged only for display, newest first (wonAt DESC):
 *   • REAL winners — existing gift requests (reward_redemptions) an admin has accepted:
 *     APPROVED / PREPARING / SHIPPED / IN_TRANSIT / DELIVERED. Pending, rejected,
 *     cancelled and returned requests never appear. wonAt = the request's createdAt.
 *     Read only: nothing here touches points, balances, the ledger or the requests.
 *   • DEMO winners — computed, never stored: ONLY the existing Top Members demo members
 *     (demo_comp_members — same id, name, photo and avatar colour; no new identity, never a
 *     real affiliate) on recurring 30-day cycles: each member wins 3–4 times per cycle, never on
 *     consecutive days, a catalogue gift per win chosen among the gifts active AT that instant
 *     (rebuilt from the gift audit trail, so later catalogue changes never alter it). The schedule is a pure function of
 *     (seed, member id, cycle), so refreshing never changes past wins, and a member added or
 *     archived during a month never moves anyone else's wins. Only past instants are returned.
 *     Every demo item carries demo: true (the slider then shows the discreet
 *     simulation footnote); demo items are never written to any rewards table.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { casablancaLocal } from './casablancaTime.js';

/** Gift-request statuses that count as a win (accepted by an admin; never pending / void / returned). */
export const WINNER_STATUSES = Object.freeze(['APPROVED', 'PREPARING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED']);
/** Most winners the slider receives (newest first). */
export const MAX_WINNERS = 30;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── Display name ──────────────────────────────────────────────────────────────

/** "Omar Benali" → "Omar B." ; "Hajar N." stays "Hajar N." ; one word stays as is ; empty → null. */
export function maskDisplayName(name) {
  const words = String(name ?? '').replace(/[<>]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const first = words[0].slice(0, 24);
  if (words.length === 1) return first;
  const last = words[words.length - 1].replace(/\.+$/, '');
  const initial = Array.from(last)[0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

/** A demo member's public name exactly as Top Members shows it (already "First L."), cleaned only. */
export function demoDisplayName(name) {
  const n = String(name ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || null;
}

const safeUrl = (u) => (typeof u === 'string' && /^(https?:\/\/|\/)[^\s"'<>]*$/i.test(u.trim()) ? u.trim() : null);
const firstImage = (images) => (Array.isArray(images) ? safeUrl(images.find((i) => typeof i === 'string' && i)) : null);

// ── Real winners ──────────────────────────────────────────────────────────────

/**
 * A reward_redemptions row (with its affiliate's name / avatar) → public winner item.
 * Only the masked name, the avatar, the gift name / image and the date leave the server;
 * the key is opaque (no request id, reference, affiliate id, address or phone).
 */
export function realWinnerItem(row) {
  if (!row || !WINNER_STATUSES.includes(row.status)) return null;
  const at = new Date(row.createdAt);
  if (Number.isNaN(at.getTime())) return null;
  const snap = row.giftSnapshot && typeof row.giftSnapshot === 'object' ? row.giftSnapshot : {};
  const giftName = String(snap.name ?? '').trim();
  if (!giftName) return null;
  return {
    key: `r-${opaqueKey(String(row.id))}`,
    name: maskDisplayName(row.affiliate?.name),
    avatarUrl: safeUrl(row.affiliate?.avatarUrl),
    avatarKey: null,
    giftName,
    giftImage: safeUrl(snap.image),
    wonAt: at.toISOString(),
    demo: false,
  };
}

// ── Demo winners (computed, read only) ───────────────────────────────────────

/** FNV-1a 32-bit — deterministic, same result on every server instance. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const opaqueKey = (s) => hash32(`rw|${s}`).toString(36) + hash32(`rw2|${s}`).toString(36);

// Demo schedule — recurring 30-day cycles (internal simulation rules; no admin setting).
export const DEMO_CYCLE_DAYS = 30;
/** Wins per demo member per cycle: 3 or 4 (deterministic per member and cycle). */
export const DEMO_WINS_PER_CYCLE = Object.freeze({ min: 3, max: 4 });
/** Winning time of day: 09:00 … 22:59 UTC (Casablanca: same or one hour later). */
const DEMO_FIRST_MINUTE = 9 * 60;
const DEMO_SPAN_MINUTES = 14 * 60;
const CYCLE_MS = DEMO_CYCLE_DAYS * DAY;

/** Day-aligned start of cycle 0 (the Top Members start): UTC midnight of `anchor`. */
export const cycleAnchorMs = (anchor) => { if (anchor === null || anchor === undefined || anchor === '') return NaN; const t = new Date(anchor).getTime(); return Number.isFinite(t) ? Math.floor(t / DAY) * DAY : NaN; };
/** Index of the 30-day cycle containing instant `t` (cycle 0 starts at the anchor day). */
export const demoCycleOf = (t, anchorMs) => Math.floor((new Date(t).getTime() - anchorMs) / CYCLE_MS);

/**
 * The scheduled wins of ONE demo member in ONE cycle — a pure function of (seed, member id, cycle):
 *   • 3 or 4 wins; the cycle is cut into that many equal segments and each win falls on a day inside
 *     its own segment, never on a segment's last day → two wins of a member are always ≥ 2 days apart
 *     (also across two cycles: the last win is on day ≤ 28, the next cycle starts on day 30);
 *   • each member has its own pattern, so members do not all win on the same days;
 *   • adding, removing or renaming another member never changes this member's schedule.
 * Returns [{ i, at }] (ms), ascending.
 */
export function memberCycleSchedule(seed, memberId, cycle, anchorMs) {
  const base = `${seed}|${memberId}|${cycle}`;
  const span = DEMO_WINS_PER_CYCLE.max - DEMO_WINS_PER_CYCLE.min + 1;
  const n = DEMO_WINS_PER_CYCLE.min + (hash32(`${base}|n`) % span);
  const cycleStart = anchorMs + cycle * CYCLE_MS;
  const out = [];
  for (let i = 0; i < n; i++) {
    const segStart = Math.floor((i * DEMO_CYCLE_DAYS) / n);
    const segLen = Math.floor(((i + 1) * DEMO_CYCLE_DAYS) / n) - segStart;
    const day = segStart + (hash32(`${base}|${i}|d`) % Math.max(1, segLen - 1));
    const minute = DEMO_FIRST_MINUTE + (hash32(`${base}|${i}|t`) % DEMO_SPAN_MINUTES);
    out.push({ i, at: cycleStart + day * DAY + minute * MIN });
  }
  return out;
}

// ── Stable gift assignment ─────────────────────────────────────────────────────
// A demo win at instant t draws ONLY from the gifts that were active AT t. That set is rebuilt from the
// existing, timestamped gift audit trail (reward_audit_log: GIFT_CREATE / GIFT_ACTIVATE / GIFT_DEACTIVATE /
// GIFT_ARCHIVE / GIFT_RESTORE — the only ways a gift's active state changes; gifts are archived, never
// deleted). Every later catalogue change is dated after t, so it can never change a past win's gift.

/** Audit actions that change a gift's active state. */
export const GIFT_STATE_ACTIONS = Object.freeze(['GIFT_CREATE', 'GIFT_ACTIVATE', 'GIFT_DEACTIVATE', 'GIFT_ARCHIVE', 'GIFT_RESTORE']);
const liveState = (st) => !!st && st.isActive === true && !st.archivedAt;

/**
 * Periods [from, to) during which a gift was active (offered in the catalogue), from its audit events.
 * @param {{createdAt,isActive,archivedAt}} gift  current row
 * @param {Array<{action,before,after,createdAt}>} events  this gift's audit events (any order)
 * Without any audit event (e.g. a row inserted outside the admin), its current state is taken from its creation.
 */
export function giftActiveIntervals(gift, events = []) {
  const ev = (Array.isArray(events) ? events : []).filter((e) => e && GIFT_STATE_ACTIONS.includes(e.action) && Number.isFinite(new Date(e.createdAt).getTime()))
    .slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const born = new Date(gift?.createdAt ?? 0).getTime() || 0;
  let active;
  let from = born;
  if (!ev.length) active = liveState(gift);
  else if (ev[0].action === 'GIFT_CREATE') active = false; // the create event sets the first state
  else active = liveState(ev[0].before); // history older than the audit trail: the state before the first event
  const out = [];
  for (const e of ev) {
    const at = new Date(e.createdAt).getTime();
    const next = liveState(e.after);
    if (next && !active) from = at;
    if (!next && active && at > from) out.push([from, at]);
    active = next;
  }
  if (active) out.push([from, Infinity]);
  return out;
}

const activeAt = (g, t) => (Array.isArray(g.activeIntervals) ? g.activeIntervals : [[-Infinity, Infinity]]).some(([a, b]) => t >= a && t < b);

/**
 * The gift of one demo win, among the gifts active at that instant (rendezvous hashing: a fixed score per
 * gift for this win, the best one is taken; independent of the catalogue order).
 */
export function pickGift(gifts, winKey) {
  let best = null, bestScore = -1;
  for (const g of gifts) {
    const score = hash32(`${winKey}|${g.id}`);
    if (score > bestScore || (score === bestScore && String(g.id) < String(best.id))) { best = g; bestScore = score; }
  }
  return best;
}

/**
 * Demo wins of the current and the previous 30-day cycle that are already past, newest first.
 * Display only: nothing is stored, no real account, point, balance, stock or request is involved.
 * @param {object} p
 * @param {Array<{id,name,photoUrl,createdAt,until}>} p.members  the EXISTING Top Members demo members
 *        (until = when the member was archived / disabled, else null)
 * @param {Array<{id,name,images,activeIntervals}>} p.gifts  the catalogue with each gift's active periods
 *        (giftActiveIntervals); a win only draws from the gifts active at its own instant
 * @param {Date|number} p.now
 * @param {Date|string} p.anchor   start of the Top Members competition (engine initializedAt)
 * @param {string} [p.seed]        schedule seed (stable: the anchor)
 */
export function demoWinners({ members, gifts, now, anchor, seed = 'ecome' } = {}) {
  const nowMs = new Date(now).getTime();
  const anchorMs = cycleAnchorMs(anchor);
  const mem = (Array.isArray(members) ? members : []).filter((m) => m && m.id && demoDisplayName(m.name));
  const gif = (Array.isArray(gifts) ? gifts : []).filter((g) => g && g.id && String(g.name ?? '').trim());
  if (!mem.length || !gif.length || !Number.isFinite(nowMs) || !Number.isFinite(anchorMs) || nowMs < anchorMs) return [];
  const current = demoCycleOf(nowMs, anchorMs);
  const out = [];
  for (const m of mem) {
    const bornMs = m.createdAt ? new Date(m.createdAt).getTime() : -Infinity;
    const untilMs = m.until ? new Date(m.until).getTime() : Infinity;
    for (let cycle = Math.max(0, current - 1); cycle <= current; cycle++) {
      for (const { i, at } of memberCycleSchedule(seed, m.id, cycle, anchorMs)) {
        // only while this identity existed and was active, never in the future
        if (at > nowMs || at < bornMs || at >= untilMs) continue;
        const pool = gif.filter((g) => activeAt(g, at)); // fixed for a past instant
        if (!pool.length) continue; // no gift was offered at that time → no win
        const g = pickGift(pool, `${seed}|${m.id}|${cycle}|${i}`);
        out.push({
          key: `d-${opaqueKey(`${m.id}|${cycle}|${i}`)}`,
          name: demoDisplayName(m.name),
          avatarUrl: safeUrl(m.photoUrl),
          avatarKey: String(m.id), // the Top Members avatar colour (initials fallback), already public there
          giftName: String(g.name).trim(),
          giftImage: firstImage(g.images),
          wonAt: new Date(at).toISOString(),
          demo: true,
        });
      }
    }
  }
  return sortWinners(out);
}

// ── Merge / order ─────────────────────────────────────────────────────────────

/** Newest first (wonAt DESC); equal instants → stable by key. */
export function sortWinners(items) {
  return (Array.isArray(items) ? items : []).filter(Boolean).slice().sort((a, b) => {
    const d = new Date(b.wonAt).getTime() - new Date(a.wonAt).getTime();
    return d !== 0 ? d : String(a.key).localeCompare(String(b.key));
  });
}

/** Real + demo winners → one list, newest first, at most `limit` items. */
export function mergeWinners(real, demo, limit = MAX_WINNERS) {
  return sortWinners([...(real || []), ...(demo || [])]).slice(0, Math.max(0, limit));
}

// ── Display (browser) ─────────────────────────────────────────────────────────

/** "HH:MM" in Casablanca (one rule table, same on server and browser). */
export const winnerTime = (iso) => {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? casablancaLocal(ms).time : '';
};

/** Arabic count phrase with the correct plural form (1, 2, 3–10, 11+). */
function arCount(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

/**
 * Relative winning date: "منذ ساعتين", "منذ يوم", "منذ 3 أيام" / "il y a 2 h", "il y a 1 jour".
 * A future instant (clock skew) reads as "now".
 */
export function relativeWin(iso, nowMs, lang) {
  const ms = new Date(iso).getTime();
  const diff = Math.max(0, (Number.isFinite(nowMs) ? nowMs : Date.now()) - ms);
  const ar = lang === 'ar';
  if (!Number.isFinite(ms) || diff < MIN) return ar ? 'الآن' : "à l'instant";
  if (diff < HOUR) {
    const n = Math.floor(diff / MIN);
    return ar ? `منذ ${arCount(n, ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة'])}` : `il y a ${n} min`;
  }
  if (diff < DAY) {
    const n = Math.floor(diff / HOUR);
    return ar ? `منذ ${arCount(n, ['ساعة', 'ساعتين', 'ساعات', 'ساعة'])}` : `il y a ${n} h`;
  }
  const n = Math.floor(diff / DAY);
  return ar ? `منذ ${arCount(n, ['يوم', 'يومين', 'أيام', 'يومًا'])}` : `il y a ${n} jour${n > 1 ? 's' : ''}`;
}

// ── Slider (browser) ──────────────────────────────────────────────────────────

/** Cards visible at once for a slider `width` (px): 3 from 300 px (360 px+ phones included), else 2, else 1. */
export function perViewFor(width) {
  if (!(width > 0) || width >= 300) return 3;
  return width >= 220 ? 2 : 1;
}

/**
 * Start index of every page: one page per `perView` winners, the last page aligned to the end.
 * Going through the pages in order shows every winner once per cycle (never the first ones again
 * before the older ones), then the cycle restarts at page 0.
 */
export function pageStarts(n, perView) {
  const count = Math.max(0, Math.floor(n) || 0);
  const pv = Math.max(1, Math.floor(perView) || 1);
  if (count <= pv) return [0];
  const starts = [];
  for (let s = 0; s < count - pv; s += pv) starts.push(s);
  starts.push(count - pv);
  return starts;
}
