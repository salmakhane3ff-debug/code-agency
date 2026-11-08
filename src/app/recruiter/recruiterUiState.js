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
 * Dashboard redesign (UI only — every value below comes straight from an existing API answer, nothing
 * is estimated or invented; a missing source gives null / an empty series, shown as an empty state):
 *   • individualProgressDisplay  affiliates whose individual reward is currently held (awarded − reversed
 *                                rows of GET /api/recruiter/progress) out of the whole network
 *   • groupRemaining             affiliates still needed for the next group reward
 *   • orderStatusSeries          real orders by status (GET /api/recruiter/network/stats; null = withheld)
 *   • levelSeries                affiliates per absolute level (active / inactive), the deep tail grouped
 *   • dashboardAlerts            the recruiter's real alerts (account, identity, permissions, rewards off)
 *   • isPublicRecruiterPath / sectionForPath  Phase 2: which routes get the app shell, which menu entry is current
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

// ── Dashboard redesign (UI only) ────────────────────────────────────────────────

/**
 * Individual reward progress of the whole network (GET /api/recruiter/progress → progress):
 * `held` = individual rewards currently held (each reversal closes exactly one reward, so awarded −
 * reversed rows = affiliates whose reward is held now), out of `total` = every affiliate of the network.
 */
export function individualProgressDisplay(s) {
  if (!s || typeof s !== "object") return null;
  const total = nonNeg(s.downlineAffiliates);
  const held = Math.max(0, nonNeg(s.rewards?.individual?.awarded) - nonNeg(s.rewards?.individual?.reversed));
  const base = Math.max(total, held);
  return {
    enabled: s.individualEnabled === true,
    threshold: posInt(s.individualThreshold),
    held,
    total,
    pct: base ? percent(held, base) : 0,
    text: `${held} / ${total}`,
  };
}

/** Affiliates still needed for the next group reward (null when the group size is unknown). */
export function groupRemaining(g) {
  const size = posInt(g?.size);
  return size ? Math.max(0, size - Math.min(nonNeg(g?.toward), size)) : null;
}

/** Real order statuses of the network, in display order (labels live in the page). */
export const ORDER_STATUS_KEYS = ["delivered", "pending", "confirmed", "shipped", "cancelled", "returned", "other"];

/**
 * Real orders of the network by status → [{ key, value }] in ORDER_STATUS_KEYS order, or null when the
 * order counts are withheld (canViewOrders off → stats.orders is null). Test orders are never counted.
 */
export function orderStatusSeries(orders) {
  const real = orders && typeof orders === "object" ? orders.real : null;
  if (!real || typeof real !== "object") return null;
  return ORDER_STATUS_KEYS.map((key) => ({ key, value: nonNeg(real[key]) }));
}

/**
 * Affiliates per absolute level (stats.levels) → [{ label, level, active, inactive, affiliates }], at most
 * `max` bars: the levels deeper than max − 1 are summed into one "N+" bar (nothing dropped). The label is
 * the level number only (the chart names the axis "المستوى").
 */
export function levelSeries(levels, max = 8) {
  const rows = (Array.isArray(levels) ? levels : [])
    .filter((l) => Number.isInteger(l?.level) && l.level >= 1)
    .map((l) => ({ level: l.level, active: nonNeg(l.active), inactive: nonNeg(l.inactive), affiliates: nonNeg(l.affiliates) }))
    .sort((a, b) => a.level - b.level);
  const cap = posInt(max) ?? 8;
  if (rows.length <= cap) return rows.map((r) => ({ ...r, label: `${r.level}` }));
  const head = rows.slice(0, cap - 1).map((r) => ({ ...r, label: `${r.level}` }));
  const tail = rows.slice(cap - 1);
  const sum = (k) => tail.reduce((n, r) => n + r[k], 0);
  return [...head, { level: tail[0].level, label: `${tail[0].level}+`, active: sum("active"), inactive: sum("inactive"), affiliates: sum("affiliates") }];
}

/**
 * The recruiter's real alerts (the header bell) → [{ id, tone, text, href }]: account disabled, identity
 * not approved (or unknown), creation / order view turned off by the admin, rewards switched off.
 * `identity` = { status } | null, `identityFailed` = the KYC request failed (unknown — never "not verified").
 */
export function dashboardAlerts({ me = null, perms = null, identity = null, identityFailed = false, progress = null } = {}) {
  const out = [];
  if (me && me.status !== "ACTIVE") out.push({ id: "disabled", tone: "red", text: "حسابك معطّل حالياً من طرف الإدارة.", href: null });
  if (identityFailed) out.push({ id: "kyc-unknown", tone: "slate", text: "حالة التحقق من الهوية غير متاحة حالياً.", href: "/recruiter/verification" });
  else if (identity?.status === "NOT_SUBMITTED") out.push({ id: "kyc", tone: "amber", text: "أرسل بطاقتك الوطنية: التحقق مطلوب قبل أي طلب سحب.", href: "/recruiter/verification" });
  else if (identity?.status === "PENDING") out.push({ id: "kyc", tone: "amber", text: "بطاقتك الوطنية قيد المراجعة.", href: "/recruiter/verification" });
  else if (identity?.status === "REJECTED") out.push({ id: "kyc", tone: "red", text: "تم رفض بطاقتك الوطنية: أعد إرسالها.", href: "/recruiter/verification" });
  if (perms && perms.canCreateAffiliates !== true) out.push({ id: "create-off", tone: "slate", text: "إنشاء أفلييت جدد معطّل لحسابك من طرف الإدارة.", href: null });
  if (perms && perms.canViewOrders !== true) out.push({ id: "orders-off", tone: "slate", text: "عرض أرقام الطلبات معطّل لحسابك من طرف الإدارة.", href: null });
  if (progress && progress.individualEnabled !== true && progress.groupEnabled !== true) out.push({ id: "rewards-off", tone: "slate", text: "المكافآت غير مفعّلة حالياً.", href: null });
  return out;
}

// ── Phase 2: one recruiter app (UI only) ────────────────────────────────────────

/** Routes of the recruiter area that are PUBLIC (no session, no app shell): the login page. */
export const PUBLIC_RECRUITER_PATHS = ["/recruiter/login"];
const under = (p, base) => p === base || p.startsWith(`${base}/`);
const normPath = (pathname) => String(pathname ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";

/** true for a public recruiter route (rendered without the authenticated shell). */
export function isPublicRecruiterPath(pathname) {
  const p = normPath(pathname);
  return PUBLIC_RECRUITER_PATHS.some((base) => under(p, base));
}

/**
 * The menu entry to highlight for a recruiter route (null when none). Simplified dashboard: three main sections —
 * "home", "affiliates" (the list, the details / network view, the creation page "add" when allowed, and the former
 * tree URL /recruiter/network that now leads there) and "wallet" — and the "المزيد" entries "profile",
 * "verification", "password", "activation" and "stats" (the network statistics).
 */
export function sectionForPath(pathname, perms) {
  const p = normPath(pathname);
  if (p === "/recruiter") return "home";
  if (under(p, "/recruiter/network/stats")) return "stats";
  if (under(p, "/recruiter/network")) return "affiliates";
  if (under(p, "/recruiter/affiliates/new")) return perms?.canCreateAffiliates === true ? "add" : "affiliates";
  if (under(p, "/recruiter/affiliates/activation")) return "activation";
  if (under(p, "/recruiter/affiliates")) return "affiliates";
  if (under(p, "/recruiter/wallet")) return "wallet";
  if (under(p, "/recruiter/profile")) return "profile";
  if (under(p, "/recruiter/verification")) return "verification";
  if (under(p, "/recruiter/password")) return "password";
  return null;
}
