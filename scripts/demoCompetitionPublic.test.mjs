#!/usr/bin/env node
/**
 * scripts/demoCompetitionPublic.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * PUBLIC Demo Competition UI (Top Members / Top Brands — SIMULATION ONLY).
 * Proves:
 *   • livePolling.js (pure): self-scheduling timeout (no setInterval), no
 *     overlapping requests, pause while hidden / off-screen, immediate refetch
 *     on resume, stop = abort + no callback, errors keep the last good data,
 *     `cache: "no-store"`; diffRanks / movementOf (up / down / new / value change)
 *   • i18n: same keys ar / fr, no empty value, every key used by the UI exists,
 *     money / relative time / initials helpers
 *   • static: the UI only calls /api/demo-competition/*, the disclosure is on
 *     every page and every card, the flame classes are keyed on rank 1 / 2 / 3
 *     only, reduced-motion handling (CSS media query + MotionConfig /
 *     useReducedMotion), no Math.random, landing-mode allowlist, homepage
 *     builder types + DEFAULTS, renderer map, sitemap.
 * Run: node scripts/demoCompetitionPublic.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPoller, createJsonFetcher, diffRanks, movementOf, isAbortError, POLL_INTERVAL_MS, HIGHLIGHT_MS,
} from "../src/lib/demoCompetition/livePolling.js";
import {
  DEMO_COMP_TEXT, DEMO_EVENT_TYPES, demoT, demoLang, demoDir, formatAmount, formatMoney, formatCount,
  relativeTime, initials, hueOf, currencyUnit,
} from "../src/lib/demoCompetition/i18n.js";
import { flameClass, flameSpaceClass, FLAME_RANKS } from "../src/components/demoCompetition/flame.js";
import * as L from "../src/lib/landingMode.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS ", name); } else { fail++; console.log("  FAIL ", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

// ── fakes ─────────────────────────────────────────────────────────────────────
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    pending,
    set(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clear(id) { pending.delete(id); },
    /** Run the (single) pending timer. */
    fire() { const [id, t] = [...pending.entries()][0] ?? []; if (id === undefined) return false; pending.delete(id); t.fn(); return true; },
    delays() { return [...pending.values()].map((t) => t.ms); },
  };
}
function fakeFetcher() {
  const calls = [];
  const fetcher = (signal) => new Promise((resolve, reject) => {
    const call = { signal, resolve, reject };
    if (signal) signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
    calls.push(call);
  });
  return { calls, fetcher, last: () => calls[calls.length - 1] };
}
function setup(opts = {}) {
  const timers = fakeTimers();
  const f = fakeFetcher();
  const got = { data: [], errors: [] };
  const poller = createPoller({
    fetcher: f.fetcher, timers, intervalMs: POLL_INTERVAL_MS,
    onData: (d) => got.data.push(d), onError: (e, last) => got.errors.push({ e, last }),
    ...opts,
  });
  return { timers, f, got, poller };
}

// ── 1. livePolling.js ────────────────────────────────────────────────────────
console.log("\n1. livePolling.js — scheduling");
{
  ok("interval is 5000 ms, highlight ~1.5 s", POLL_INTERVAL_MS === 5000 && HIGHLIGHT_MS === 1500);

  const { timers, f, got, poller } = setup();
  poller.start();
  ok("start → one request immediately, nothing scheduled while it runs", f.calls.length === 1 && timers.pending.size === 0 && poller.getState().inFlight);
  poller.refresh(); poller.refresh(); poller.start();
  ok("in-flight guard: refresh / start while a request runs → still ONE request (no overlap)", f.calls.length === 1);
  f.last().resolve({ v: 1 });
  await flush();
  ok("on success → onData(data) and exactly one timeout of 5000 ms scheduled", got.data.length === 1 && got.data[0].v === 1 && timers.pending.size === 1 && timers.delays()[0] === 5000);
  timers.fire();
  ok("timeout fires → next request (self-scheduling; no timer pending while it runs)", f.calls.length === 2 && timers.pending.size === 0);
  f.last().resolve({ v: 2 });
  await flush();
  ok("chain continues: 2nd data delivered, one new timeout", got.data.length === 2 && timers.pending.size === 1);

  // hidden while a timeout is pending
  poller.setHidden(true);
  ok("document hidden → pending timeout cleared, no request", timers.pending.size === 0 && f.calls.length === 2 && !poller.getState().active);
  poller.setHidden(true);
  ok("hidden twice → still nothing", timers.pending.size === 0 && f.calls.length === 2);
  poller.setHidden(false);
  ok("visible again → immediate refetch", f.calls.length === 3 && poller.getState().inFlight);
  poller.setHidden(false);
  ok("visible again while the request runs → no second request", f.calls.length === 3);

  // hidden while in flight: completion must not schedule
  poller.setHidden(true);
  f.last().resolve({ v: 3 });
  await flush();
  ok("hidden during a request → data kept, but no next timeout", got.data.length === 3 && timers.pending.size === 0);
  poller.setHidden(false);
  ok("resume → immediate refetch", f.calls.length === 4);
  f.last().resolve({ v: 4 });
  await flush();

  // off-screen
  poller.setOnScreen(false);
  ok("element off-screen → timeout cleared, paused", timers.pending.size === 0 && !poller.getState().active);
  ok("no timer → nothing fires while off-screen", timers.fire() === false && f.calls.length === 4);
  poller.setOnScreen(true);
  ok("back on screen → immediate refetch", f.calls.length === 5);

  // error keeps last data
  f.last().reject(Object.assign(new Error("HTTP 500"), { status: 500 }));
  await flush();
  ok("error → onError(err, lastGoodData), no onData, last data kept", got.errors.length === 1 && got.errors[0].last.v === 4 && got.data.length === 4 && poller.getState().lastData.v === 4);
  ok("error → polling goes on (next timeout scheduled)", timers.pending.size === 1);
  timers.fire();
  f.last().resolve({ v: 6 });
  await flush();
  ok("recovery after an error → new data", got.data.length === 5 && poller.getState().lastError === null);

  // stop with a pending timeout
  poller.stop();
  ok("stop → pending timeout cleared", timers.pending.size === 0 && poller.getState().stopped);
  poller.refresh(); poller.setHidden(false); poller.setOnScreen(true);
  ok("after stop nothing restarts", f.calls.length === 6);
}
{
  const { timers, f, got, poller } = setup();
  poller.start();
  const call = f.last();
  poller.stop();
  ok("stop (unmount) during a request → its AbortSignal is aborted", call.signal && call.signal.aborted);
  await flush();
  ok("aborted request → no onData / onError, no timeout", got.data.length === 0 && got.errors.length === 0 && timers.pending.size === 0);
}
{
  const { timers, f, got, poller } = setup();
  poller.start();
  const call = f.last();
  poller.stop();
  call.resolve({ late: true });
  await flush();
  ok("a response arriving after stop is ignored", got.data.length === 0 && timers.pending.size === 0);
}
{
  const { f, poller } = setup({ onScreen: false });
  poller.start();
  ok("starts off-screen (observer not answered yet) → no request", f.calls.length === 0);
  poller.setOnScreen(true);
  ok("first on-screen notification → first request", f.calls.length === 1);
}
{
  const { f, poller } = setup({ hidden: true });
  poller.start();
  ok("starts in a hidden tab → no request until visible", f.calls.length === 0);
  poller.setHidden(false);
  ok("tab shown → first request", f.calls.length === 1);
}
console.log("\n1b. createJsonFetcher");
{
  const seen = [];
  const fakeFetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
  const ctrl = new AbortController();
  const data = await createJsonFetcher("/api/demo-competition/members?limit=21", fakeFetch)(ctrl.signal);
  ok("fetch with cache: \"no-store\" + the abort signal", seen[0].init.cache === "no-store" && seen[0].init.signal === ctrl.signal && data.ok === 1);
  let err = null;
  try { await createJsonFetcher("/x", async () => ({ ok: false, status: 404, json: async () => ({}) }))(); } catch (e) { err = e; }
  ok("non-2xx → Error with status (404 → profile not found)", err && err.status === 404);
  ok("isAbortError", isAbortError({ name: "AbortError" }) && !isAbortError(new Error("x")) && !isAbortError(null));
}

console.log("\n1c. diffRanks / movementOf");
{
  const prev = [{ id: "a", rank: 1, earnings30dCents: 100 }, { id: "b", rank: 2, earnings30dCents: 90 }, { id: "c", rank: 3, earnings30dCents: 80 }];
  const next = [{ id: "b", rank: 1, earnings30dCents: 120 }, { id: "a", rank: 2, earnings30dCents: 100 }, { id: "d", rank: 3, earnings30dCents: 85 }];
  const d = diffRanks(prev, next);
  ok("b moved up 1 + value changed", d.b.moved === 1 && d.b.valueChanged && !d.b.isNew);
  ok("a moved down 1, value unchanged", d.a.moved === -1 && !d.a.valueChanged);
  ok("d is new", d.d.isNew && d.d.moved === 0);
  ok("ids absent from next (c) are not reported", !("c" in d) && Object.keys(d).length === 3);
  const same = diffRanks(next, next.map((x) => ({ ...x })));
  ok("same snapshot → moved 0, no change, nothing new", Object.values(same).every((x) => x.moved === 0 && !x.valueChanged && !x.isNew));
  const first = diffRanks(null, next);
  ok("first load (no previous snapshot) → nothing moved / new / changed", Object.values(first).every((x) => x.moved === 0 && !x.isNew && !x.valueChanged) && Object.keys(first).length === 3);
  const big = diffRanks([{ id: "z", rank: 9, x: 1 }], [{ id: "z", rank: 2, x: 2 }], { valueKey: "x" });
  ok("custom valueKey + multi-place jump (+7)", big.z.moved === 7 && big.z.valueChanged);
  ok("garbage input → {}", Object.keys(diffRanks(undefined, undefined)).length === 0 && Object.keys(diffRanks([], [null, {}])).length === 0);

  ok("movementOf: live up wins over 24 h", JSON.stringify(movementOf({ moved: 2 }, -3)) === JSON.stringify({ kind: "up", n: 2, source: "live" }));
  ok("movementOf: live down", movementOf({ moved: -1 }, 5).kind === "down" && movementOf({ moved: -1 }, 5).n === 1);
  ok("movementOf: new", movementOf({ isNew: true, moved: 0 }, 2).kind === "new");
  ok("movementOf: no live move → 24 h change (first load)", movementOf({ moved: 0 }, 3).source === "24h" && movementOf(undefined, -2).kind === "down" && movementOf(undefined, 0).kind === "same");
  ok("movementOf: nothing known → none", movementOf(undefined, null).kind === "none");
}

// ── 2. i18n ───────────────────────────────────────────────────────────────────
console.log("\n2. i18n");
const UI_DIR = "src/components/demoCompetition";
const UI_FILES = readdirSync(join(ROOT, UI_DIR)).filter((f) => /\.(jsx?|css)$/.test(f)).map((f) => `${UI_DIR}/${f}`);
const PAGE_FILES = ["src/app/top-members/page.jsx", "src/app/top-members/[id]/page.jsx", "src/app/top-brands/page.jsx", "src/app/top-brands/[id]/page.jsx"];
const LIB_FILES = ["src/lib/demoCompetition/i18n.js", "src/lib/demoCompetition/livePolling.js"];
const ALL_UI = [...UI_FILES, ...PAGE_FILES, ...LIB_FILES];
const SRC = Object.fromEntries(ALL_UI.map((f) => [f, read(f)]));
{
  const fr = DEMO_COMP_TEXT.fr, ar = DEMO_COMP_TEXT.ar;
  const kf = Object.keys(fr).sort(), ka = Object.keys(ar).sort();
  ok(`same keys in ar and fr (${kf.length})`, JSON.stringify(kf) === JSON.stringify(ka), { onlyFr: kf.filter((k) => !(k in ar)), onlyAr: ka.filter((k) => !(k in fr)) });
  const empties = [...kf.filter((k) => !String(fr[k]).trim()).map((k) => `fr.${k}`), ...ka.filter((k) => !String(ar[k]).trim()).map((k) => `ar.${k}`)];
  ok("no empty value", empties.length === 0, empties);
  const varsOf = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const varMismatch = kf.filter((k) => varsOf(fr[k]) !== varsOf(ar[k]));
  ok("same {placeholders} in both languages", varMismatch.length === 0, varMismatch);
  ok("frozen dictionaries", Object.isFrozen(DEMO_COMP_TEXT) && Object.isFrozen(fr) && Object.isFrozen(ar));

  const used = new Set();
  for (const f of ALL_UI.filter((x) => x.endsWith(".jsx"))) {
    for (const m of stripJs(SRC[f]).matchAll(/\bt\(\s*["']([a-z0-9_]+)["']/gi)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in fr));
  ok(`every t("key") used by the UI exists (${used.size} keys)`, used.size > 40 && missing.length === 0, missing);
  const dynamic = [...DEMO_EVENT_TYPES.map((x) => `event_${x}`), "moved_up", "moved_down", "moved_up_24h", "moved_down_24h"];
  ok("dynamic keys (event_<TYPE>, moved_<dir>[_24h]) exist", dynamic.every((k) => k in fr && k in ar), dynamic.filter((k) => !(k in fr)));
  ok("disclosure wording: fr \"Démo / Simulation\", ar \"عرض توضيحي / محاكاة\"", fr.sim_badge === "Démo / Simulation" && ar.sim_badge === "عرض توضيحي / محاكاة");
  ok("banner says simulated, not real sales / earnings, not withdrawable (fr + ar)",
    /simulées/.test(fr.sim_banner) && /vraies ventes/.test(fr.sim_banner) && /vrais gains/.test(fr.sim_banner) && /retirable/.test(fr.sim_banner)
    && /محاكاة/.test(ar.sim_banner) && /مبيعات حقيقية/.test(ar.sim_banner) && /سحب/.test(ar.sim_banner));

  const t = demoT("fr"), ta = demoT("ar");
  ok("demoT interpolation {var}", t("rank_of", { rank: 2, total: 21 }) === "Rang 2 sur 21" && ta("rank_of", { rank: 2, total: 21 }) === "المرتبة 2 من 21");
  ok("demoT: unknown var kept, unknown key → key, unknown lang → fr", t("rank_of", { rank: 1 }).includes("{total}") && t("nope") === "nope" && demoT("en")("live") === "En direct");
  ok("lang / dir", demoLang("ar") === "ar" && demoLang("xx") === "fr" && demoDir("ar") === "rtl" && demoDir("fr") === "ltr");
  const nb = (s) => s.replace(/[  ]/g, " ");
  ok("money: centimes / 100, fr \"DH\"", nb(formatMoney(123400, "fr")) === "1 234 DH" && nb(formatMoney(9050, "fr")) === "90,50 DH", [formatMoney(123400, "fr"), formatMoney(9050, "fr")]);
  ok("money: ar \"درهم\" with Western digits", formatMoney(123400, "ar") === "1,234 درهم" && currencyUnit("ar") === "درهم" && formatAmount(9050, "ar") === "90.50");
  ok("count formatting", nb(formatCount(12345, "fr")) === "12 345" && formatCount(null, "ar") === "0");
  const now = "2026-11-09T12:00:00.000Z";
  ok("relative time (fr)", relativeTime("2026-11-09T11:59:30Z", now, "fr") === "à l'instant" && relativeTime("2026-11-09T11:55:00Z", now, "fr") === "il y a 5 min"
    && relativeTime("2026-11-09T09:00:00Z", now, "fr") === "il y a 3 h" && relativeTime("2026-11-07T12:00:00Z", now, "fr") === "il y a 2 j");
  ok("relative time (ar) + invalid date → ''", relativeTime("2026-11-09T11:55:00Z", now, "ar") === "منذ 5 دقيقة" && relativeTime("bad", now, "fr") === "");
  ok("initials fallback (never a generic logo)", initials("Sara El Amrani") === "SA" && initials("nadia") === "N" && initials("  ") === "?" && initials("مريم بنعلي") === "مب");
  ok("deterministic hue", hueOf("abc") === hueOf("abc") && hueOf("abc") >= 0 && hueOf("abc") < 360);
}

// ── 3. static checks ──────────────────────────────────────────────────────────
console.log("\n3. Static checks");
{
  // API usage
  const apiRefs = ALL_UI.flatMap((f) => [...stripJs(SRC[f]).matchAll(/["'`](\/api\/[^"'`$]*)/g)].map((m) => ({ f, url: m[1] })));
  ok(`only /api/demo-competition/* is called (${apiRefs.length} references)`, apiRefs.length >= 4 && apiRefs.every((r) => r.url.startsWith("/api/demo-competition/")), apiRefs.filter((r) => !r.url.startsWith("/api/demo-competition/")));
  const fetchers = ALL_UI.filter((f) => /\bfetch\s*\(|globalThis\.fetch/.test(stripJs(SRC[f])));
  ok("network access only through livePolling.js (no fetch in components / pages)", fetchers.length === 1 && fetchers[0] === "src/lib/demoCompetition/livePolling.js", fetchers);
  ok("no admin endpoint referenced", !ALL_UI.some((f) => /\/api\/admin/.test(SRC[f])));
  ok("pages poll the expected endpoints",
    /\/api\/demo-competition\/members\?limit=\$\{MAX_MEMBERS\}/.test(SRC[`${UI_DIR}/TopMembersPage.jsx`])
    && /\/api\/demo-competition\/brands\?limit=\$\{MAX_BRANDS\}/.test(SRC[`${UI_DIR}/TopBrandsPage.jsx`])
    && /\/api\/demo-competition\/members\/\$\{encodeURIComponent\(id\)\}/.test(SRC[`${UI_DIR}/MemberProfile.jsx`])
    && /\/api\/demo-competition\/brands\/\$\{encodeURIComponent\(id\)\}/.test(SRC[`${UI_DIR}/BrandProfile.jsx`]));

  // Polling rules
  const hook = stripJs(SRC[`${UI_DIR}/useLivePolling.js`]);
  const lib = stripJs(SRC["src/lib/demoCompetition/livePolling.js"]);
  ok("never setInterval in the polling code", !/setInterval/.test(lib) && !/setInterval/.test(hook));
  ok("cache: \"no-store\" in the fetcher", /cache:\s*"no-store"/.test(lib));
  ok("hook: visibilitychange + IntersectionObserver + stop on unmount + 404 → notFound",
    /visibilitychange/.test(hook) && /IntersectionObserver/.test(hook) && /poller\.stop\(\)/.test(hook) && /removeEventListener\("visibilitychange"/.test(hook)
    && /io\.disconnect\(\)/.test(hook) && /status === 404/.test(hook) && /notFound: true/.test(hook));
  ok("hook: error keeps the previous data (functional update spreading prev)", /setState\(\(prev\) => \(\{ \.\.\.prev, error: err/.test(hook));

  // Disclosure on every page and card
  const shell = stripJs(SRC[`${UI_DIR}/ProfileParts.jsx`]);
  ok("PageShell always renders <SimulationDisclosure> (before any branch)", /export function PageShell[\s\S]*?<SimulationDisclosure t=\{t\} \/>[\s\S]*?\{children\}/.test(shell));
  for (const p of ["TopMembersPage", "TopBrandsPage", "MemberProfile", "BrandProfile"]) {
    const s = stripJs(SRC[`${UI_DIR}/${p}.jsx`]);
    ok(`${p}: rendered inside PageShell (disclosure) + SimulationBadge`, /<PageShell\b/.test(s) && /<SimulationBadge\b/.test(s));
  }
  for (const p of ["HomeTopMembers", "HomeTopBrands"]) {
    const s = stripJs(SRC[`${UI_DIR}/${p}.jsx`]);
    // Approved design: the homepage sections share HomeSectionFrame, which renders the badge + the disclaimer.
    ok(`${p}: rendered inside HomeSectionFrame (badge + disclaimer)`, /<HomeSectionFrame\b/.test(s));
  }
  {
    const frame = stripJs(SRC[`${UI_DIR}/HomeSectionFrame.jsx`]);
    // Compact homepage preview: every panel keeps its "Démo / Simulation" badge; the disclaimer is shown ONCE for the
    // block (DemoCompetitionBlock banner) instead of being repeated in each section (owner's request: no repeated disclaimers).
    const blk = stripJs(SRC[`${UI_DIR}/DemoCompetitionBlock.jsx`]);
    // On phones the panel badge is icon-only (label kept as accessible name / tooltip) so the panel header stays one line.
    ok("HomeSectionFrame: <SimulationBadge> always rendered; the block banner carries the single disclaimer (sim_banner)", /<SimulationBadge t=\{t\} iconOnlyOnPhone \/>/.test(frame)
      && /"aria-label": t\("sim_badge"\)/.test(stripJs(SRC[`${UI_DIR}/Badges.jsx`]))
      && !/SimulationDisclosure/.test(frame) && /t\("sim_banner"\)/.test(blk) && /t\("sim_banner_title"\)/.test(blk) && /t\("sim_badge"\)/.test(blk));
  }
  for (const c of ["MemberRow", "BrandRow"]) {
    const s = stripJs(SRC[`${UI_DIR}/${c}.jsx`]);
    // Approved design: both rows render the shared LeaderCard, which carries the badge on every card.
    ok(`${c}: every card is a LeaderCard (which shows <SimulationBadge>)`, /export function \w+Row[\s\S]*?<LeaderCard\b[\s\S]*?export function \w+sLeaderboard/.test(s));
  }
  {
    const card = stripJs(SRC[`${UI_DIR}/LeaderCard.jsx`]);
    ok("LeaderCard: <SimulationBadge> on every card (unconditional), live badge, movement, rank badge", /<SimulationBadge t=\{t\} \/>/.test(card) && /<LiveBadge live=\{live\}/.test(card)
      && /<MovementIndicator diff=\{diff\}/.test(card) && /<RankBadge rank=\{rank\}/.test(card));
  }
  const badges = stripJs(SRC[`${UI_DIR}/Badges.jsx`]);
  ok("SimulationBadge / SimulationDisclosure use the i18n disclosure texts", /t\("sim_badge"\)/.test(badges) && /t\("sim_banner"\)/.test(badges) && /t\("sim_banner_title"\)/.test(badges));
  const pageMap = { "src/app/top-members/page.jsx": "TopMembersPage", "src/app/top-brands/page.jsx": "TopBrandsPage", "src/app/top-members/[id]/page.jsx": "MemberProfile", "src/app/top-brands/[id]/page.jsx": "BrandProfile" };
  for (const [f, comp] of Object.entries(pageMap)) {
    ok(`${f} renders ${comp} + metadata labelled Démo / Simulation`, new RegExp(`import ${comp} from "@/components/demoCompetition/${comp}"`).test(SRC[f]) && new RegExp(`<${comp}\\b`).test(SRC[f]) && /Démo \/ Simulation/.test(SRC[f]));
  }

  // Brand identity: circular product image + initials fallback
  const avatar = stripJs(SRC[`${UI_DIR}/Avatar.jsx`]);
  ok("Avatar: rounded-full image + initials fallback (also on load error)", /rounded-full object-cover/.test(avatar) && /initials\(name\)/.test(avatar) && /onError/.test(avatar));
  const brandRow = stripJs(SRC[`${UI_DIR}/BrandRow.jsx`]);
  ok("BrandRow: product image (imageUrl) as main identity + owner name + owner photo", /src=\{brand\.imageUrl\}/.test(brandRow) && /owner\.photoUrl/.test(brandRow) && /owner_by/.test(brandRow));
  const brandProfile = stripJs(SRC[`${UI_DIR}/BrandProfile.jsx`]);
  ok("BrandProfile: owner links to /top-members/[ownerId] only when owner.public", /owner\.public \? \(\s*<Link\s+href=\{`\/top-members\/\$\{encodeURIComponent\(owner\.id\)\}`\}/.test(brandProfile));
  const memberProfile = stripJs(SRC[`${UI_DIR}/MemberProfile.jsx`]);
  ok("MemberProfile: network kept separate, \"not configured\" when network.configured=false",
    /n\.configured/.test(memberProfile) && /t\("network_off"\)/.test(memberProfile) && /t\("not_configured"\)/.test(memberProfile) && /networkEarningsCents/.test(memberProfile) && /t\("personal_title"\)/.test(memberProfile));

  // Flame
  ok("flameClass: ranks 1 / 2 / 3 only, distinct classes", FLAME_RANKS.join() === "1,2,3" && flameClass(1) === "dc-flame dc-flame--1" && flameClass(2) === "dc-flame dc-flame--2" && flameClass(3) === "dc-flame dc-flame--3");
  ok("flameClass: no flame for 0, 4, 21, null, undefined, \"1\"", [0, 4, 21, null, undefined, "1", NaN].every((r) => flameClass(r) === "" && flameSpaceClass(r) === ""));
  const css = SRC[`${UI_DIR}/demoCompetition.css`];
  const flameMods = [...css.matchAll(/\.dc-flame--(\w+)/g)].map((m) => m[1]);
  ok("CSS: flame modifiers exist only for 1, 2, 3", flameMods.length >= 3 && flameMods.every((m) => ["1", "2", "3"].includes(m)) && ["1", "2", "3"].every((m) => flameMods.includes(m)), [...new Set(flameMods)]);
  // Approved design: the Top-3 flame became a SUBTLE gold / silver / bronze glow (same class names, CSS only).
  ok("CSS: subtle Top-3 glow — gold / silver / bronze borders + soft glow, opacity-only breathing on #1 (no GIF / video)",
    /\.dc-flame--1 \{[^}]*border-color: #fbbf24/.test(css) && /\.dc-flame--2 \{[^}]*border-color/.test(css) && /\.dc-flame--3 \{[^}]*border-color/.test(css)
    && /@keyframes dc-breathe \{[^}]*opacity[^}]*\}/.test(css) && !/\.(gif|mp4|webm)/i.test(css));
  for (const f of ["MemberRow.jsx", "BrandRow.jsx", "MemberProfile.jsx", "BrandProfile.jsx"]) {
    ok(`${f}: flame driven by the CURRENT rank`, /flameClass\((member|brand|m|b)\.rank\)/.test(stripJs(SRC[`${UI_DIR}/${f}`])));
  }
  ok("globals.css untouched by the flame", !/dc-flame/.test(read("src/app/globals.css")));

  // Reduced motion
  const rm = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/);
  ok("CSS: prefers-reduced-motion disables the flame / pulse animations (static glow kept)", !!rm && /\.dc-flame::before/.test(rm[1]) && /\.dc-flame::after/.test(rm[1]) && /\.dc-live-dot::after/.test(rm[1]) && /animation: none/.test(rm[1]));
  ok("LeaderboardList: framer-motion layout + MotionConfig reducedMotion=\"user\", keyed by id",
    /<MotionConfig reducedMotion="user">/.test(SRC[`${UI_DIR}/LeaderboardList.jsx`]) && /<motion\.li[\s\S]*?key=\{item\.id\}[\s\S]*?layout/.test(SRC[`${UI_DIR}/LeaderboardList.jsx`]));
  const countUp = stripJs(SRC[`${UI_DIR}/CountUp.jsx`]);
  ok("CountUp: requestAnimationFrame tween skipped with useReducedMotion()", /useReducedMotion\(\)/.test(countUp) && /requestAnimationFrame/.test(countUp) && /if \(reduce \|\|/.test(countUp) && /cancelAnimationFrame/.test(countUp));
  ok("numbers rendered as LTR islands (<bdi dir=\"ltr\">)", /<bdi dir="ltr"/.test(countUp) && /<bdi dir="ltr"/.test(badges));

  // No randomness
  const rnd = ALL_UI.filter((f) => /Math\.random/.test(SRC[f]));
  ok(`no Math.random in any demo UI file (${ALL_UI.length} files)`, rnd.length === 0, rnd);
  const css2 = ALL_UI.filter((f) => /globals\.css/.test(stripJs(SRC[f])));
  ok("no import of globals.css from the demo UI", css2.length === 0, css2);
}

// ── 4. routing, sitemap, homepage builder ────────────────────────────────────
console.log("\n4. Landing mode, sitemap, homepage builder");
{
  const lm = read("src/lib/landingMode.js");
  ok("landingMode.js: ALWAYS_PREFIXES contains /top-members and /top-brands", /const ALWAYS_PREFIXES = \[[^\]]*"\/top-members"[^\]]*"\/top-brands"[^\]]*\];/.test(lm));
  const cfg = { enabled: true, redirectUrl: "/landing/offer", allowedPaths: [] };
  const ev = (pathname) => L.evaluateLandingRedirect({ pathname, origin: "https://shop.example.com", config: cfg });
  const paths = ["/top-members", "/top-members/abc123", "/top-brands", "/top-brands/xyz"];
  ok("Landing Page Only Mode never redirects the leaderboards / profiles", paths.every((p) => ev(p).action === "next" && L.isAlwaysAllowed(p)), paths.map((p) => [p, ev(p).action]));
  ok("prefix boundary: /top-membersx is still redirected; / still redirected", ev("/top-membersx").action === "redirect" && ev("/").action === "redirect");

  const sm = read("src/app/sitemap.ts");
  ok("sitemap: /top-members and /top-brands in the static list", /url: `\$\{BASE_URL\}\/top-members`/.test(sm) && /url: `\$\{BASE_URL\}\/top-brands`/.test(sm));

  const hb = read("src/app/admin/homepage-builder/page.jsx");
  ok("builder: SECTION_TYPES has top_members + top_brands (icon, label, desc)",
    /\{ type: "top_members",\s+icon: Trophy,[^}]*label: "[^"]+",\s+desc: "[^"]+" \}/.test(hb) && /\{ type: "top_brands",\s+icon: Award,[^}]*label: "[^"]+",\s+desc: "[^"]+" \}/.test(hb));
  ok("builder: DEFAULTS { title: \"\", previewCount: 5, showViewAll: true } for both",
    /top_members:\s+\{ title: "", previewCount: 5, showViewAll: true \}/.test(hb) && /top_brands:\s+\{ title: "", previewCount: 5, showViewAll: true \}/.test(hb));
  ok("builder: EDIT_FORMS has both, previewCount bounded 1..21 / 1..20, showViewAll checkbox",
    /top_members: EditTopMembers/.test(hb) && /top_brands: EditTopBrands/.test(hb) && /max=\{21\}/.test(hb) && /max=\{20\}/.test(hb) && /showViewAll: e\.target\.checked/.test(hb));
  const rr = read("src/components/HomeBuilder/HomeSectionRenderer.jsx");
  ok("renderer: RENDERERS map has both", /top_members:\s+\(\{ data, id \}\) => <HomeTopMembers data=\{data\} sectionId=\{id\} \/>/.test(rr) && /top_brands:\s+\(\{ data, id \}\) => <HomeTopBrands data=\{data\} sectionId=\{id\} \/>/.test(rr));
  ok("renderer: consecutive demo sections are grouped in one DemoCompetitionBlock (community heading once), other sections unchanged",
    /export function groupDemoSections\(sections\)/.test(rr) && /<DemoCompetitionBlock count=\{sec\.group\.length\}>/.test(rr) && /groupDemoSections\(sections\.filter\(s => s\.visible !== false\)\)/.test(rr));
  ok("renderer: both contained (CONTAINER_SECTIONS)", /CONTAINER_SECTIONS = new Set\(\[[\s\S]*"top_members",\s*"top_brands",[\s\S]*?\]\)/.test(rr));
  {
    // Approved mobile design (homepage leaderboards).
    const card = stripJs(SRC[`${UI_DIR}/LeaderCard.jsx`]);
    const list = stripJs(SRC[`${UI_DIR}/LeaderboardList.jsx`]);
    const block = stripJs(SRC[`${UI_DIR}/DemoCompetitionBlock.jsx`]);
    ok("design: crown only on rank 1, online dot only when live, names bidi-isolated", /\{rank === 1 && <Crown className="dc-crown"/.test(card) && /\{live && <span className="dc-online-dot"/.test(card) && /<bdi>\{name\}<\/bdi>/.test(card));
    ok("design: cards adapt to their OWN width (container queries) — two rows when narrow, one row when wide", /@container/.test(list) && /@2xl:grid-cols-2/.test(list) && /@2xl:first:col-span-2/.test(list)
      && /@2xl:grid-cols-\[auto_auto_minmax\(0,1fr\)_auto_auto\]/.test(card) && /@sm:col-start-2/.test(card));
    // Compact homepage: ONE short banner per block (real data only: participant counts reported by the sections and the
    // rolling 30-day window — no monthly cycle / days left, which do not exist), two columns on desktop.
    ok("design: one compact banner per block (title, real counts, rolling 30-day window), two columns on desktop, hidden when every section is empty",
      /t\("community_title"\)/.test(block) && /t\("rolling_window"\)/.test(block) && /t\("banner_participants"\)/.test(block) && /totals\.member/.test(block)
      && /lg:grid-cols-2/.test(block) && /hidden=\{allEmpty\}/.test(block) && !/cycle|daysLeft|jours restants/i.test(block));
    ok("design: banner texts exist in fr and ar (no cycle wording)", ["community_title", "rolling_window", "banner_participants", "banner_brands", "orders_short", "updates_live"]
      .every((k) => !!DEMO_COMP_TEXT.fr[k] && !!DEMO_COMP_TEXT.ar[k]) && !/cycle/i.test(DEMO_COMP_TEXT.fr.rolling_window));
    const compact = stripJs(SRC[`${UI_DIR}/CompactLeaderboard.jsx`]);
    const hm = stripJs(SRC[`${UI_DIR}/HomeTopMembers.jsx`]), hb = stripJs(SRC[`${UI_DIR}/HomeTopBrands.jsx`]);
    ok("compact homepage: both sections render CompactLeaderboard (not the large cards); the full pages keep the detailed cards",
      /<CompactLeaderboard kind="member"/.test(hm) && /<CompactLeaderboard kind="brand"/.test(hb) && !/LeaderCard|MembersLeaderboard|BrandsLeaderboard/.test(hm + hb)
      && /<MembersLeaderboard\b/.test(stripJs(SRC[`${UI_DIR}/TopMembersPage.jsx`])) && /<BrandsLeaderboard\b/.test(stripJs(SRC[`${UI_DIR}/TopBrandsPage.jsx`])));
    ok("compact rows: one structure for every rank (medal 1-3, #n after), small 34 px image, live dot, crown on #1, names bidi-isolated",
      /size=\{34\}/.test(compact) && /rank >= 1 && rank <= 3\) return <RankBadge rank=\{rank\} t=\{t\} size="sm" \/>/.test(compact) && /#\{rank\}/.test(compact)
      && /\{item\.live && <span className="dc-online-dot dc-online-dot--sm"/.test(compact) && /\{item\.rank === 1 && <Crown/.test(compact) && /<bdi className="line-clamp-2 break-words">\{item\.name\}<\/bdi>/.test(compact));
    ok("compact rows: each row opens the existing detail page (member / brand) and shows orders + earnings (30 d), live, movement",
      /`\/\$\{isBrand \? "top-brands" : "top-members"\}\/\$\{encodeURIComponent\(item\.id\)\}`/.test(compact) && /<Count value=\{item\.orders30d\}/.test(compact)
      && /<Money cents=\{item\.earnings30dCents\}/.test(compact) && /<LiveBadge live=\{item\.live\}/.test(compact) && /<MovementIndicator diff=\{diff\}/.test(compact));
    const cssC = SRC[`${UI_DIR}/demoCompetition.css`];
    ok("compact rows: Top 3 tinted gold / silver / bronze, no animation of their own; reduced motion removes transitions",
      /\.dc-row--1 \{[^}]*border-color: #fcd34d/.test(cssC) && /\.dc-row--2 \{/.test(cssC) && /\.dc-row--3 \{/.test(cssC) && !/\.dc-row[^{]*\{[^}]*animation/.test(cssC)
      && /prefers-reduced-motion: reduce[\s\S]*\.dc-row \{ transition: none; \}/.test(cssC));
    ok("design: Top-3 glow static under prefers-reduced-motion (no breathing)", /prefers-reduced-motion: reduce[\s\S]*\.dc-flame::before \{ opacity: 1; \}/.test(SRC[`${UI_DIR}/demoCompetition.css`]));
  }
  const home = stripJs(SRC[`${UI_DIR}/HomeTopMembers.jsx`]);
  const homeB = stripJs(SRC[`${UI_DIR}/HomeTopBrands.jsx`]);
  ok("home sections: previewCount → limit, View all link only when showViewAll, observed polling (ref)",
    /members\?limit=\$\{count\}/.test(home) && /brands\?limit=\$\{count\}/.test(homeB) && /showViewAll !== false/.test(home) && /showViewAll !== false/.test(homeB)
    && /viewAllHref="\/top-members"/.test(home) && /viewAllHref="\/top-brands"/.test(homeB) && /sectionRef=\{ref\}/.test(home) && /sectionRef=\{ref\}/.test(homeB)
    && /href=\{viewAllHref\}/.test(stripJs(SRC[`${UI_DIR}/HomeSectionFrame.jsx`])) && /ref=\{sectionRef\}/.test(stripJs(SRC[`${UI_DIR}/HomeSectionFrame.jsx`])));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
