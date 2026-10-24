#!/usr/bin/env node
/**
 * scripts/liveActivity.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 — Live Activity (simulated feed). Proves, without a DB (injected fake
 * db with a simulated advisory lock + source checks):
 *   • delivery-related events only at 08:00 ≤ Casablanca time < 20:00
 *     (07:59 / 08:00 / 19:59 / 20:00, normal UTC+1 and Ramadan UTC+0)
 *   • Casablanca business day / midnight rollover, 25 h and 23 h days
 *   • catch-up and bootstrap events keep their TRUE timestamps
 *   • relative labels + clock labels derived from those timestamps
 *   • simulated/demo disclosure in the payload and always in the UI
 *   • one generation at a time (lock + single-flight), no duplicates
 *   • a failed state/config read writes nothing and keeps the last good data
 *   • the engine touches only its own settings row; financial code untouched
 * Real-Postgres lock behaviour: scripts/liveActivity.harness.mjs.
 * Run: node scripts/liveActivity.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import {
  isDeliveryHour, probabilitiesAt, casablancaClock, casablancaClockLabel, liveActivityDayKey,
  liveActivityDayStart, eventTimeLabel, DELIVERY_RELATED_TYPES, LIVE_ACTIVITY_DISCLOSURE,
  LIVE_ACTIVITY_TIMEZONE,
} from "../src/lib/liveActivityTime.js";
import {
  nextState, salvageState, advanceLiveActivity, getLiveActivitySnapshot,
  resetLiveActivityCacheForTests, STATE_KEY, LIVE_ACTIVITY_LOCK_KEYS,
} from "../src/lib/services/liveActivityEngine.js";
import { normalizeLiveActivity, relTime } from "../src/lib/recruitmentCta.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = async (fn) => {
  const e = console.error, w = console.warn; const logs = [];
  console.error = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" "));
  try { return { out: await fn(), logs }; } finally { console.error = e; console.warn = w; }
};

// Seeded PRNG → deterministic generation.
function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n) => String(n).padStart(2, "0");
// UTC ms of a Casablanca wall-clock time (verified against the tz data).
function casa(y, mo, d, h, mi, s = 0) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  for (const offMin of [60, 0, 120, -60]) {
    const t = naive - offMin * 60000;
    const c = casablancaClock(t);
    if (c.hour === h && c.minute === mi && liveActivityDayKey(t) === `${y}-${pad(mo)}-${pad(d)}`) return t;
  }
  throw new Error(`no Casablanca time ${y}-${mo}-${d} ${h}:${mi}`);
}

const POOL = [
  { id: "p1", name: "Karima", username: "karima", avatarUrl: "/a.webp", avatarColor: "#111" },
  { id: "p2", name: "Samira", username: "samira", avatarUrl: null, avatarColor: "#222" },
  { id: "p3", name: "Nadia", username: "nadia", avatarUrl: null, avatarColor: "#333" },
];
// avg tick = (2+6)/2 = 4 s
const cfgWith = (extra = {}) => normalizeLiveActivity({ intervalMinSec: 2, intervalMaxSec: 6, ...extra });
const ONLY_DELIVERY = { probabilities: { delivered: 50, commission: 50, newOrder: 0, ugc: 0, newAffiliate: 0, competition: 0, booster: 0 } };
const AVG = 4000;

// ── Fake db: interactive transaction + transaction-scoped advisory lock.
// Any model other than `setting` (or any other id than the state row) throws.
function makeDb({ initial = null, readDelay = 0 } = {}) {
  let row = initial ? { id: STATE_KEY, data: structuredClone(initial) } : null;
  let lockHeld = false;
  const calls = { tx: 0, reads: 0, writes: [], lockSql: [] };
  const target = {
    calls, failRead: false,
    get row() { return row; },
    async $transaction(fn) {
      calls.tx++;
      let mine = false;
      const txTarget = {
        $queryRaw: async (strings, ...vals) => {
          calls.lockSql.push({ sql: strings.join("?"), vals });
          if (!lockHeld) { lockHeld = true; mine = true; return [{ locked: true }]; }
          return [{ locked: false }];
        },
        setting: {
          findUnique: async ({ where }) => {
            calls.reads++;
            if (readDelay) await sleep(readDelay);
            if (target.failRead) throw new Error("connection terminated");
            return row && where.id === row.id ? { id: row.id, data: structuredClone(row.data) } : null;
          },
          upsert: async ({ where, update, create }) => {
            if (where.id !== STATE_KEY) throw new Error(`unexpected write to ${where.id}`);
            if (readDelay) await sleep(readDelay);
            calls.writes.push(where.id);
            row = { id: where.id, data: structuredClone(row ? update.data : create.data) };
            return row;
          },
        },
      };
      const tx = new Proxy(txTarget, { get: (t, k) => { if (k in t) return t[k]; throw new Error(`unexpected tx access: ${String(k)}`); } });
      try { return await fn(tx); } finally { if (mine) lockHeld = false; } // released at commit/rollback
    },
  };
  return new Proxy(target, {
    get: (t, k) => { if (k in t) return t[k]; throw new Error(`unexpected db access: ${String(k)}`); },
  });
}
const depsFor = (db, now, extra = {}) => ({
  db, now, rnd: rng(7),
  loadConfig: async () => ({ liveActivity: { intervalMinSec: 2, intervalMaxSec: 6 } }),
  loadCommission: async () => 4,
  loadPool: async () => POOL,
  loadBoosterFacts: async () => [],
  ...extra,
});
const isDeliveryType = (t) => DELIVERY_RELATED_TYPES.includes(t);

// ── 1. Delivery window boundaries ────────────────────────────────────────────
console.log("\n1. Delivery hours (Africa/Casablanca)");
for (const [label, y, mo, d] of [["normal UTC+1", 2026, 6, 15], ["Ramadan UTC+0", 2026, 3, 1]]) {
  ok(`${label}: 07:59 → no delivery events`, !isDeliveryHour(casa(y, mo, d, 7, 59)));
  ok(`${label}: 07:59:59 → no delivery events`, !isDeliveryHour(casa(y, mo, d, 7, 59, 59)));
  ok(`${label}: 08:00 → delivery allowed`, isDeliveryHour(casa(y, mo, d, 8, 0)));
  ok(`${label}: 19:59 → delivery allowed`, isDeliveryHour(casa(y, mo, d, 19, 59)));
  ok(`${label}: 19:59:59 → delivery allowed`, isDeliveryHour(casa(y, mo, d, 19, 59, 59)));
  ok(`${label}: 20:00 → no delivery events`, !isDeliveryHour(casa(y, mo, d, 20, 0)));
  ok(`${label}: 03:00 → no delivery events`, !isDeliveryHour(casa(y, mo, d, 3, 0)));
}
ok("fixtures really differ: 08:00 local = 07:00Z (UTC+1) / 08:00Z (Ramadan)",
  casa(2026, 6, 15, 8, 0) === Date.UTC(2026, 5, 15, 7, 0) && casa(2026, 3, 1, 8, 0) === Date.UTC(2026, 2, 1, 8, 0));
ok("same UTC instant 07:30Z: allowed in June (08:30 local), not in Ramadan (07:30 local)",
  isDeliveryHour(Date.UTC(2026, 5, 15, 7, 30)) && !isDeliveryHour(Date.UTC(2026, 2, 1, 7, 30)));
ok("delivery-related types = delivered + commission", JSON.stringify(DELIVERY_RELATED_TYPES) === '["delivered","commission"]');
{
  const p = cfgWith().probabilities;
  const night = probabilitiesAt(p, casa(2026, 6, 15, 20, 0));
  ok("outside hours: delivered/commission weight 0, others unchanged",
    night.delivered === 0 && night.commission === 0 && night.newOrder === p.newOrder && night.ugc === p.ugc && night.booster === p.booster);
  ok("inside hours: probabilities unchanged", probabilitiesAt(p, casa(2026, 6, 15, 8, 0)) === p);
  ok("input probabilities never mutated", p.delivered > 0 && p.commission > 0);
}

// Generation at the boundaries (delivery-only config: outside hours the
// engine must fall back to a non-delivery type).
for (const [h, mi, allowed] of [[7, 59, false], [8, 0, true], [19, 59, true], [20, 0, false]]) {
  const tickAt = casa(2026, 6, 15, h, mi);
  const stored = { dayKey: "2026-06-15", resetToken: "", counters: { todayOrders: 10, todayDelivered: 5, todayCommissions: 100, affiliatesOnline: 9 },
    events: [{ id: "old", type: "newOrder", at: tickAt - AVG }], lastTickAt: tickAt - AVG };
  const { state } = nextState(stored, cfgWith(ONLY_DELIVERY), { pool: POOL, commissionPerSale: 4, now: tickAt, rnd: rng(3) });
  const ev = state.events[0];
  ok(`tick at ${pad(h)}:${pad(mi)} → ${allowed ? "delivery event" : "non-delivery event"} (got ${ev.type})`,
    ev.at === tickAt && isDeliveryType(ev.type) === allowed);
  ok(`tick at ${pad(h)}:${pad(mi)} → todayDelivered ${allowed && ev.type === "delivered" ? "may grow" : "unchanged"}`,
    allowed || state.counters.todayDelivered === 5);
}
{
  // Property: across a whole Casablanca day (both regimes), no delivery-related
  // event ever carries an out-of-hours timestamp.
  let violations = 0, deliveries = 0, total = 0;
  for (const [y, mo, d] of [[2026, 6, 15], [2026, 3, 1]]) {
    let stored = null;
    for (let t = casa(y, mo, d, 0, 1); t < casa(y, mo, d, 23, 58); t += 7 * 60000) {
      const { state } = nextState(stored, cfgWith(), { pool: POOL, commissionPerSale: 4, now: t, rnd: rng(t % 9973) });
      stored = state;
      for (const e of state.events) { total++; if (isDeliveryType(e.type)) { deliveries++; if (!isDeliveryHour(e.at)) violations++; } }
    }
  }
  ok(`full-day sweep: ${deliveries} delivery events, 0 outside 08:00–20:00`, violations === 0 && deliveries > 0 && total > 0);
}

// ── 2. Timezone / date boundaries ────────────────────────────────────────────
console.log("\n2. Casablanca business day and boundaries");
ok("23:59:59 local (22:59:59Z, UTC+1) is still 15 June", liveActivityDayKey(Date.UTC(2026, 5, 15, 22, 59, 59)) === "2026-06-15");
ok("00:00 local (23:00Z, UTC+1) is already 16 June", liveActivityDayKey(Date.UTC(2026, 5, 15, 23, 0, 0)) === "2026-06-16");
ok("Ramadan: 23:59Z is still 1 March, 00:00Z is 2 March", liveActivityDayKey(Date.UTC(2026, 2, 1, 23, 59)) === "2026-03-01" && liveActivityDayKey(Date.UTC(2026, 2, 2, 0, 0)) === "2026-03-02");
ok("day start of 15 Feb 2026 (clocks go back 03:00→02:00) = 14 Feb 23:00Z, 25 h day",
  liveActivityDayStart(casa(2026, 2, 15, 12, 0)) === Date.UTC(2026, 1, 14, 23, 0)
  && liveActivityDayStart(casa(2026, 2, 16, 12, 0)) - liveActivityDayStart(casa(2026, 2, 15, 12, 0)) === 25 * 3600000);
ok("day start of 22 Mar 2026 (clocks go forward 02:00→03:00) = 22 Mar 00:00Z, 23 h day",
  liveActivityDayStart(casa(2026, 3, 22, 12, 0)) === Date.UTC(2026, 2, 22, 0, 0)
  && liveActivityDayStart(casa(2026, 3, 23, 12, 0)) - liveActivityDayStart(casa(2026, 3, 22, 12, 0)) === 23 * 3600000);
ok("day start is exactly local 00:00 and the ms before is the previous day (both switch days + normal day)",
  [casa(2026, 2, 15, 12, 0), casa(2026, 3, 22, 12, 0), casa(2026, 6, 15, 12, 0)].every((t) => {
    const s0 = liveActivityDayStart(t);
    return casablancaClockLabel(s0) === "00:00" && liveActivityDayKey(s0) === liveActivityDayKey(t) && liveActivityDayKey(s0 - 1) !== liveActivityDayKey(t);
  }));
{
  // 00:30 local on 15 Feb 2026 (= 23:30Z on 14 Feb): a noon-sampled offset would
  // put "today" at 00:00Z — in the future — and stamp bootstrap events there.
  const now = casa(2026, 2, 15, 0, 30);
  const { state } = nextState(null, cfgWith(), { pool: POOL, commissionPerSale: 4, now, rnd: rng(21) });
  ok("bootstrap at 00:30 on the switch-back night: no event in the future, none before local midnight",
    now === Date.UTC(2026, 1, 14, 23, 30) && state.events.every((e) => e.at <= now && e.at >= Date.UTC(2026, 1, 14, 23, 0)));
}
ok("08:00 after the switch-back is 08:00Z (UTC+0), 08:00 after the switch-forward is 07:00Z",
  casa(2026, 2, 15, 8, 0) === Date.UTC(2026, 1, 15, 8, 0) && casa(2026, 3, 22, 8, 0) === Date.UTC(2026, 2, 22, 7, 0));
{
  const yesterday = { dayKey: "2026-06-15", resetToken: "", counters: { todayOrders: 999, todayDelivered: 900, todayCommissions: 99999, affiliatesOnline: 50 },
    events: [{ id: "y", type: "newOrder", at: casa(2026, 6, 15, 23, 59) }], lastTickAt: casa(2026, 6, 15, 23, 59) };
  const now = casa(2026, 6, 16, 0, 0, 20);
  const { state } = nextState(yesterday, cfgWith(), { pool: POOL, commissionPerSale: 4, now, rnd: rng(5) });
  ok("Casablanca midnight rollover → new day, yesterday's events dropped", state.dayKey === "2026-06-16" && !state.events.some((e) => e.id === "y"));
  ok("rollover counters restart from the configured stats (as before)", state.counters.todayOrders < 999);
  ok("bootstrap at 00:00:20 never back-dates before local midnight", state.events.every((e) => e.at >= liveActivityDayStart(now)) && state.events.length === 15);
}

// ── 3. True timestamps (catch-up + bootstrap) ────────────────────────────────
console.log("\n3. Catch-up events keep their true timestamps");
{
  const now = casa(2026, 6, 15, 12, 0);
  const last = now - 10.5 * AVG;
  const old = [{ id: "e1", type: "newOrder", at: last - AVG }, { id: "e0", type: "newOrder", at: last - 2 * AVG }];
  const stored = { dayKey: "2026-06-15", resetToken: "", counters: { todayOrders: 10, todayDelivered: 5, todayCommissions: 100, affiliatesOnline: 9 }, events: old, lastTickAt: last };
  const { state, dirty } = nextState(stored, cfgWith(), { pool: POOL, commissionPerSale: 4, now, rnd: rng(11) });
  const fresh = state.events.filter((e) => !["e0", "e1"].includes(e.id));
  ok("10 elapsed ticks → capped at 3 events (no counter leap)", dirty && fresh.length === 3);
  ok("they carry the last 3 tick slots (last+8, +9, +10 ticks), not 'now'",
    JSON.stringify(fresh.map((e) => e.at).sort((a, b) => a - b)) === JSON.stringify([last + 8 * AVG, last + 9 * AVG, last + 10 * AVG]));
  ok("no catch-up event is stamped at 'now'", fresh.every((e) => e.at < now));
  ok("feed stays newest-first", state.events.every((e, i, a) => i === 0 || a[i - 1].at >= e.at));
  ok("existing events keep their original timestamps", state.events.find((e) => e.id === "e1").at === last - AVG && state.events.find((e) => e.id === "e0").at === last - 2 * AVG);
  ok("tick grid advanced by whole ticks", state.lastTickAt === last + 10 * AVG);
  ok("newest label = its real age (2 s), not 'just now' from a stale stamp",
    eventTimeLabel(state.events[0].at, now) === relTime(now - (last + 10 * AVG)) && eventTimeLabel(state.events[0].at, now) === "قبل 2 ث");

  const idle = { ...stored, lastTickAt: now - 3600000, events: old.map((e) => ({ ...e, at: now - 3600000 - 1000 })) };
  const r2 = nextState(idle, cfgWith(), { pool: POOL, commissionPerSale: 4, now, rnd: rng(12) });
  const added = r2.state.events.filter((e) => !["e0", "e1"].includes(e.id));
  ok("1 h idle → still only 3 events, all within the last 3 ticks before now",
    added.length === 3 && added.every((e) => e.at > now - 3 * AVG - 1 && e.at <= now));
  ok("old events after a 1 h idle are labelled ~1 h, not 'just now'",
    eventTimeLabel(r2.state.events.find((e) => e.id === "e1").at, now) === "قبل 1 س");

  const two = { ...stored, lastTickAt: now - 2 * AVG };
  const r3 = nextState(two, cfgWith(), { pool: POOL, commissionPerSale: 4, now, rnd: rng(13) });
  ok("2 elapsed ticks → events at last+1 tick and last+2 ticks",
    JSON.stringify(r3.state.events.slice(0, 2).map((e) => e.at)) === JSON.stringify([now, now - AVG]));

  const r4 = nextState({ ...stored, lastTickAt: now - 0.5 * AVG }, cfgWith(), { pool: POOL, commissionPerSale: 4, now, rnd: rng(14) });
  ok("less than one tick elapsed → nothing generated, nothing written", !r4.dirty && r4.state.events.length === 2);

  const boot = nextState(null, cfgWith(), { pool: POOL, commissionPerSale: 4, now, rnd: rng(15) });
  ok("bootstrap: 15 events staggered one tick apart in the past",
    boot.state.events.length === 15 && boot.state.events[0].at === now - AVG && boot.state.events[14].at === now - 15 * AVG);
}

// ── 4. Relative-time display consistency ─────────────────────────────────────
console.log("\n4. Relative time and clock labels");
{
  const now = casa(2026, 6, 15, 14, 30);
  ok("15 s → قبل 15 ث", eventTimeLabel(now - 15000, now) === "قبل 15 ث");
  ok("2 min → قبل 2 د", eventTimeLabel(now - 120000, now) === "قبل 2 د");
  ok("1 h → قبل 1 س", eventTimeLabel(now - 3600000, now) === "قبل 1 س");
  ok("future timestamp (clock skew) never negative → قبل 1 ث", eventTimeLabel(now + 5000, now) === "قبل 1 ث");
  ok("clock label is Casablanca time: 07:05Z → 08:05 (June), 07:05 (Ramadan)",
    casablancaClockLabel(Date.UTC(2026, 5, 15, 7, 5)) === "08:05" && casablancaClockLabel(Date.UTC(2026, 2, 1, 7, 5)) === "07:05");

  resetLiveActivityCacheForTests();
  const db = makeDb();
  const snap = await getLiveActivitySnapshot(depsFor(db, now));
  ok("served time = label from each event's own timestamp at serverNow",
    snap.serverNow === now && snap.events.length > 0 && snap.events.every((e) => e.time === eventTimeLabel(e.at, now)));
  ok("served clock = Casablanca HH:MM of each event", snap.events.every((e) => e.clock === casablancaClockLabel(e.at)));
  ok("payload names the timezone", snap.timezone === LIVE_ACTIVITY_TIMEZONE && LIVE_ACTIVITY_TIMEZONE === "Africa/Casablanca");
  const later = await getLiveActivitySnapshot(depsFor(db, now + 2000)); // within the 3 s cache
  ok("cached snapshot is re-labelled at the request time (labels never frozen)",
    db.calls.tx === 1 && later.events[0].time === eventTimeLabel(later.events[0].at, now + 2000) && later.events[0].time !== snap.events[0].time);
}

// ── 5. Simulated / demo disclosure ───────────────────────────────────────────
console.log("\n5. Simulated-activity disclosure");
{
  resetLiveActivityCacheForTests();
  const snap = await getLiveActivitySnapshot(depsFor(makeDb(), casa(2026, 6, 15, 10, 0)));
  ok("payload: simulated true + disclosure text", snap.simulated === true && snap.disclosure === LIVE_ACTIVITY_DISCLOSURE);
  ok("every event flagged simulated", snap.events.every((e) => e.simulated === true));
  ok("disclosure text says simulated / not real", /محاكاة/.test(LIVE_ACTIVITY_DISCLOSURE) && /ماشي/.test(LIVE_ACTIVITY_DISCLOSURE) && /حقيقية/.test(LIVE_ACTIVITY_DISCLOSURE));
  const comp = src("src/components/LiveActivity.jsx");
  ok("card renders the disclosure unconditionally (not gated on the payload)",
    /data-live-activity-disclosure[^>]*>\s*⚠️ \{LIVE_ACTIVITY_DISCLOSURE\}/.test(comp) && !/data\.simulated|data\.disclosure/.test(comp));
  ok("card shows a 'محاكاة' badge in the header and the full-list modal", (comp.match(/<SimulatedBadge \/>/g) || []).length === 2);
  ok("old 'real platform activity, moment by moment' claim removed", !/لحظة بلحظة/.test(comp) && !/داخل المنصة/.test(comp));
  ok("row time is a <time> with the true ISO timestamp + Casablanca clock tooltip", /dateTime=\{Number\.isFinite\(ev\.at\)/.test(comp) && /توقيت المغرب/.test(comp));
  ok("landing + dashboard both use this shared card",
    /<LiveActivity windowSize=\{4\} showViewAll \/>/.test(src("src/app/tsajlim3ana/RecruitmentLanding.jsx")) && /<LiveActivity windowSize=\{4\} showViewAll \/>/.test(src("src/app/affiliate/dashboard/page.jsx")));
}

// ── 6. Concurrent generation protection ──────────────────────────────────────
console.log("\n6. One generation at a time");
{
  const now = casa(2026, 6, 15, 11, 0);
  const cfg = cfgWith();
  const db = makeDb({ readDelay: 15 });
  const runs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    advanceLiveActivity({ db, cfg, pool: POOL, commissionPerSale: 4, now, rnd: rng(100 + i) })));
  ok("10 overlapping workers → exactly one generates", runs.filter((r) => r.generated).length === 1);
  ok("exactly one write; stored feed = one bootstrap (15 events, no duplicates)",
    db.calls.writes.length === 1 && db.row.data.events.length === 15 && new Set(db.row.data.events.map((e) => e.id)).size === 15);
  ok("lock is pg_try_advisory_xact_lock with the engine's own keys",
    db.calls.lockSql.every((c) => /pg_try_advisory_xact_lock/.test(c.sql) && c.vals[0] === LIVE_ACTIVITY_LOCK_KEYS[0] && c.vals[1] === LIVE_ACTIVITY_LOCK_KEYS[1]));
  ok("lock keys differ from the rewards reconcile lock", LIVE_ACTIVITY_LOCK_KEYS[0] !== 0x52574453);

  const db2 = makeDb({ initial: db.row.data, readDelay: 10 });
  const runs2 = await Promise.all(Array.from({ length: 6 }, () =>
    advanceLiveActivity({ db: db2, cfg, pool: POOL, commissionPerSale: 4, now: now + 2 * AVG, rnd: rng(9) })));
  ok("overlapping catch-up: one worker adds the 2 ticks, nobody duplicates them",
    runs2.filter((r) => r.generated).length === 1 && db2.calls.writes.length === 1 && db2.row.data.events.length === 17);
  const after = await advanceLiveActivity({ db: db2, cfg, pool: POOL, commissionPerSale: 4, now: now + 2 * AVG, rnd: rng(9) });
  ok("same instant again → nothing to generate (tick grid already advanced)", after.generated === false && db2.calls.writes.length === 1);

  resetLiveActivityCacheForTests();
  const db3 = makeDb({ readDelay: 10 });
  let configLoads = 0;
  const deps = depsFor(db3, now, { loadConfig: async () => { configLoads++; await sleep(5); return { liveActivity: { intervalMinSec: 2, intervalMaxSec: 6 } }; } });
  const snaps = await Promise.all(Array.from({ length: 20 }, () => getLiveActivitySnapshot(deps)));
  ok("20 concurrent requests in one process → one load, one transaction (single-flight)", configLoads === 1 && db3.calls.tx === 1);
  ok("…and they all serve the same feed", snaps.every((s) => JSON.stringify(s.events.map((e) => e.id)) === JSON.stringify(snaps[0].events.map((e) => e.id))));
}

// ── 7. State read failures preserve data ─────────────────────────────────────
console.log("\n7. Read failures never reset or replace state");
{
  const now = casa(2026, 6, 15, 15, 0);
  const cfg = cfgWith();
  const db = makeDb();
  await advanceLiveActivity({ db, cfg, pool: POOL, commissionPerSale: 4, now, rnd: rng(1) });
  const saved = JSON.stringify(db.row.data);
  db.failRead = true;
  const err = await advanceLiveActivity({ db, cfg, pool: POOL, commissionPerSale: 4, now: now + 60000, rnd: rng(2) }).then(() => null, (e) => e);
  ok("advance with a failing read rejects and writes nothing", err && db.calls.writes.length === 1 && JSON.stringify(db.row.data) === saved);

  resetLiveActivityCacheForTests();
  const db2 = makeDb();
  const good = await getLiveActivitySnapshot(depsFor(db2, now));
  db2.failRead = true;
  const { out: stale, logs } = await quiet(() => getLiveActivitySnapshot(depsFor(db2, now + 10000)));
  ok("snapshot after a read failure = last good feed, marked stale, nothing written",
    stale.enabled === true && stale.stale === true && JSON.stringify(stale.events.map((e) => e.id)) === JSON.stringify(good.events.map((e) => e.id))
    && JSON.stringify(stale.counters) === JSON.stringify(good.counters) && db2.calls.writes.length === 1);
  ok("…labels still follow the true timestamps", stale.events.every((e) => e.time === eventTimeLabel(e.at, now + 10000)));
  ok("…and the failure is logged, not silent", logs.some((l) => /state read\/advance failed/.test(l)));

  resetLiveActivityCacheForTests();
  const db3 = makeDb({ initial: db.row.data });
  db3.failRead = true;
  const { out: none } = await quiet(() => getLiveActivitySnapshot(depsFor(db3, now)));
  ok("read failure with no last good snapshot → card hidden (degraded), stored row untouched",
    none.enabled === false && none.degraded === true && db3.calls.writes.length === 0 && JSON.stringify(db3.row.data) === saved);

  resetLiveActivityCacheForTests();
  const db4 = makeDb({ initial: db.row.data });
  const g4 = await getLiveActivitySnapshot(depsFor(db4, now + 4 * AVG));
  const txBefore = db4.calls.tx, writesBefore = db4.calls.writes.length;
  const { out: cfgFail, logs: l2 } = await quiet(() => getLiveActivitySnapshot(depsFor(db4, now + 10 * AVG, { loadConfig: async () => { throw new Error("db down"); } })));
  ok("config read failure → engine not run on defaults (no transaction, no write), last good served",
    db4.calls.tx === txBefore && db4.calls.writes.length === writesBefore && cfgFail.stale === true
    && JSON.stringify(cfgFail.events.map((e) => e.id)) === JSON.stringify(g4.events.map((e) => e.id)) && l2.some((l) => /config read failed/.test(l)));

  // Malformed but partly usable stored state: keep what is valid.
  const partial = { dayKey: "2026-06-15", resetToken: "", counters: { todayOrders: 500, todayDelivered: 400, todayCommissions: 9000, affiliatesOnline: 30 },
    events: [{ id: "keep", type: "newOrder", at: now - 1000 }, "garbage", { id: "bad", type: "newOrder" }, null], lastTickAt: now - 1000 };
  const salv = salvageState(partial);
  ok("salvage keeps valid counters and valid events, drops malformed ones",
    salv.counters.todayOrders === 500 && salv.events.length === 1 && salv.events[0].id === "keep");
  const r = nextState({ ...partial, events: "not-an-array" }, cfg, { pool: POOL, commissionPerSale: 4, now, rnd: rng(4) });
  ok("events unreadable → counters preserved (feed refilled from them, not reset to defaults)",
    r.state.counters.todayOrders >= 500 && r.state.counters.todayCommissions >= 9000 && r.state.events.length === 15);
  ok("no usable counters → nothing to keep (null)", salvageState({ counters: { todayOrders: "x" } }) === null && salvageState(null) === null && salvageState([]) === null);
}

// ── 8. Scope / regression ────────────────────────────────────────────────────
console.log("\n8. Financial and order code untouched");
{
  const engine = src("src/lib/services/liveActivityEngine.js");
  const imports = [...engine.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  ok(`engine imports only demo/settings/time helpers (${imports.join(", ")})`,
    JSON.stringify(imports) === JSON.stringify(["../liveActivityTime.js", "../prisma.js", "../recruitmentCta.js", "../ugcSettings.js",
      "./boosterSimulationService.js", "./demoService.js", "./settingsService.js"].sort()));
  ok("engine writes only its own settings row (fake db throws on anything else — all runs above passed)",
    /update: \{ data: state \}/.test(engine) && (engine.match(/\.upsert\(/g) || []).length === 1 && /where:\s+\{ id: STATE_KEY \}/.test(engine));
  ok("no order / commission / balance / payout / deposit / booster-purchase call in the engine",
    !/affiliateOrder|commissionAmount|bonusBalance|payout|deposit|purchaseBooster|createOrder|isFake/i.test(engine.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")));
  const route = src("src/app/api/live-activity/route.js");
  ok("public route still read-only GET, no auth change", /export async function GET\(\)/.test(route) && !/export (async )?function (POST|PUT|DELETE|PATCH)/.test(route));
  ok("separate landing live-feed popup not coupled to this engine", !/liveActivityEngine/.test(src("src/app/api/tsajlim3ana/live-feed/route.js")));
  ok("counter rules (applyActivityToStats) unchanged: delivered < orders", (() => {
    const c = normalizeLiveActivity({}).stats;
    return c.todayOrders > c.todayDelivered;
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
