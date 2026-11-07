/**
 * src/app/recruiter/recruiterUiState.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System, Phase 7 Stage C (UI): PURE helpers shared by the recruiter pages —
 * no React, no fetch, no "@/…" import, so scripts/recruiterDashboardUi.test.mjs can unit-test them.
 *
 *   • authAction            which API answers send the recruiter back to the login page (ONLY 401,
 *                           and 403 RECRUITER_DISABLED with its notice); anything else (5xx, 429,
 *                           network) is an error the page shows with a retry button
 *   • permsFromMe           the recruiter's permissions from GET /api/recruiter/me (only an explicit
 *                           `true` allows creating affiliates; unknown = hidden)
 *   • progressDisplay       "x / T مبيعات" of one affiliate — null (nothing shown, never zeros) when
 *                           the delivered count is withheld (canViewOrders off)
 *   • nodeBadges            "مدعو عبر الشبكة" (information) + qualified / reward state badges of one node or list item
 *   • groupProgressDisplay  the recruiter's group progress "q / groupSize"
 *   • rewardAmountsDisplay  awarded vs reversed counts and amounts (cents) of both reward types
 *   • mergeById             append a page without duplicating rows (rapid clicks, retries)
 *   • createRequestGate     discard stale responses (root / branch / search changed meanwhile)
 *   • levelLabel            ONE level wording everywhere (levels are absolute in every API)
 * Display only: the server stays the authority for every permission, amount and gate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const LOGIN_PATH = "/recruiter/login";

/** "login" (401) | "disabled" (403 RECRUITER_DISABLED) | null (show the error, keep the session). */
export function authAction(status, code) {
  if (status === 401) return "login";
  if (status === 403 && code === "RECRUITER_DISABLED") return "disabled";
  return null;
}

/** Permissions of GET /api/recruiter/me → { canViewOrders, canCreateAffiliates } (unknown = not allowed to create). */
export function permsFromMe(body) {
  const p = body?.permissions;
  if (!p || typeof p !== "object") return { canViewOrders: false, canCreateAffiliates: false };
  return { canViewOrders: p.canViewOrders === true, canCreateAffiliates: p.canCreateAffiliates === true };
}

const posInt = (v) => (Number.isInteger(v) && v >= 1 ? v : null);
const nonNeg = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** Integer percentage 0…100 of value / max (0 when max is unknown). */
export function percent(value, max) {
  const m = posInt(max);
  if (!m) return 0;
  return Math.max(0, Math.min(100, Math.floor((nonNeg(value) * 100) / m)));
}

/**
 * Progress of one affiliate: its OWN real delivered orders vs the individual threshold.
 * → null when the delivered count is withheld (canViewOrders off) — the caller then shows no count,
 *   no bar and no "qualified" badge (nothing that would read as zero).
 */
export function progressDisplay(progress) {
  if (!progress || typeof progress !== "object" || !Number.isInteger(progress.realDelivered) || progress.realDelivered < 0) return null;
  const delivered = progress.realDelivered;
  const threshold = posInt(progress.individualThreshold);
  return {
    delivered,
    threshold,
    pct: threshold ? percent(delivered, threshold) : null,
    reached: threshold ? delivered >= threshold : false,
    ratio: threshold ? `${delivered} / ${threshold}` : `${delivered}`,
    text: threshold ? `${delivered} / ${threshold} مبيعات` : `${delivered} مبيعات`,
    qualifiedIndividual: progress.qualifiedIndividual === true,
    qualifiedGroup: progress.qualifiedGroup === true,
    identityApproved: progress.identityApproved === true,
  };
}

// Phase 7 Stage E: every member of the network is reward-eligible; an affiliate the recruiter did not create
// directly (invited by one of its affiliates) only carries this neutral information badge.
export const NETWORK_INVITED_LABEL = "مدعو عبر الشبكة";
export const NETWORK_INVITED_HINT = "انضم إلى شبكتك عن طريق أحد أفلييتك (لم تُنشئه أنت مباشرة)، ويُحتسب لك في المكافآت مثل أي عضو في شبكتك.";

/**
 * Badges of one node / list item: [{ key, label, tone }] — Phase 7 Stage E: the same for every member.
 *   • linkedToMe false → first a neutral "مدعو عبر الشبكة" (information only — not an exclusion)
 *   • qualified (individual / group) when the delivered count is visible, and the latest individual
 *     reward cycle (AWARDED / REVERSED — NONE shows nothing)
 */
export function nodeBadges(node) {
  if (!node || typeof node !== "object") return [];
  const out = node.linkedToMe === true ? [] : [{ key: "invited", label: NETWORK_INVITED_LABEL, tone: "slate" }];
  const p = progressDisplay(node.progress);
  if (p?.qualifiedIndividual) out.push({ key: "qualified", label: "مؤهَّل للمكافأة", tone: "green" });
  if (p?.qualifiedGroup) out.push({ key: "qualifiedGroup", label: "يُحتسب في مكافأة المجموعة", tone: "green" });
  const rs = node.rewardState;
  const cycle = posInt(rs?.cycle);
  const suffix = cycle ? ` · الدورة ${cycle}` : "";
  if (rs?.state === "AWARDED") out.push({ key: "awarded", label: `مكافأة ممنوحة${suffix}`, tone: "green" });
  else if (rs?.state === "REVERSED") out.push({ key: "reversed", label: `مكافأة ملغاة${suffix}`, tone: "red" });
  return out;
}

/** The recruiter's group progress (GET /api/recruiter/progress → progress). */
export function groupProgressDisplay(s) {
  if (!s || typeof s !== "object") return null;
  const size = posInt(s.groupSize);
  const toward = size ? Math.min(nonNeg(s.progressTowardNextGroup), size) : 0;
  return {
    enabled: s.groupEnabled === true,
    size,
    toward,
    qualified: nonNeg(s.qualifiedForGroup),
    active: nonNeg(s.activeGroupRewards),
    pct: size ? percent(toward, size) : 0,
    text: size ? `${toward} / ${size}` : "—",
    threshold: posInt(s.groupThreshold),
  };
}

const side = (x) => {
  const awardedCents = nonNeg(x?.awardedCents);
  const reversedCents = nonNeg(x?.reversedCents);
  return { awarded: nonNeg(x?.awarded), awardedCents, reversed: nonNeg(x?.reversed), reversedCents, netCents: awardedCents - reversedCents };
};
/**
 * Awarded vs reversed (counts and cents, both positive) of both reward types and their sums —
 * straight from the server aggregates (never derived from a capped history, never invented).
 */
export function rewardAmountsDisplay(rewards) {
  const individual = side(rewards?.individual);
  const group = side(rewards?.group);
  const grossCents = individual.awardedCents + group.awardedCents;
  const reversedCents = individual.reversedCents + group.reversedCents;
  return { individual, group, grossCents, reversedCents, netCents: grossCents - reversedCents };
}

/** Cents → "1 234,50 درهم" (2 decimals, Latin digits). */
export function fmtMadCents(cents) {
  const n = Number.isInteger(cents) ? cents : 0;
  return `${(n / 100).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} درهم`;
}

/** Append `incoming` to `existing` without duplicates (by id; rows without an id are dropped). */
export function mergeById(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const row of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const id = row?.id;
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/**
 * A request sequence: `begin()` returns a token, `isCurrent(token)` is true only for the latest one.
 * A response whose token is no longer current (root / search changed, newer request) is discarded.
 */
export function createRequestGate() {
  let seq = 0;
  return {
    begin() { seq += 1; return seq; },
    isCurrent(token) { return token === seq; },
    invalidate() { seq += 1; },
  };
}

/** Levels are ABSOLUTE in every recruiter API (1 = a top affiliate of the recruiter's network). */
export function levelLabel(level) {
  return Number.isInteger(level) && level >= 1 ? `المستوى ${level}` : "بدون مستوى";
}
