#!/usr/bin/env node
/**
 * scripts/recentWinners.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Recent Winners (الفائزون مؤخراً) of the affiliate Rewards / Gifts page. Proves:
 *   1. pure rules: name masking, real-row → public item (accepted statuses only, nothing private),
 *      demo schedule (deterministic, past only, existing demo identities + catalog gifts),
 *      newest-first merge, relative dates (AR plural forms / FR), slider pages (every winner once
 *      per cycle, last page aligned to the end), cards per view;
 *   2. service over a READ-ONLY fake db (any write throws): rewards OFF → hidden; real winners =
 *      accepted requests, createdAt DESC + limit; demo only while the Demo Competition engine is
 *      ON; demo never written; cache;
 *   3. route through the REAL withAffiliateAuth: 401 without token, 403 inactive, 200 shape;
 *   4. UI wiring: placed in RewardsTab between the points card and the gift sub-tabs; no
 *      "view all" / link / other page; autoplay, arrows, swipe, dots, reduced motion, fallbacks;
 *      FR + AR texts.
 * Run: node scripts/recentWinners.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync } from "node:fs";
import {
  WINNER_STATUSES, MAX_WINNERS, maskDisplayName, realWinnerItem, demoWinners, mergeWinners, sortWinners,
  DEMO_CYCLE_DAYS, DEMO_WINS_PER_CYCLE, cycleAnchorMs, demoCycleOf, memberCycleSchedule, giftActiveIntervals, GIFT_STATE_ACTIONS,
  relativeWin, winnerTime, perViewFor, pageStarts, hash32,
} from "../src/lib/recentWinners.js";
import { getRecentWinners, recentWinnersHandler, __resetRecentWinnersCache, RECENT_WINNERS_CACHE_MS } from "../src/lib/services/recentWinnersService.js";
import { withAffiliateAuth } from "../src/lib/middleware/withAffiliateAuth.js";
import { signToken } from "../src/lib/services/authService.js";
import { REWARDS_TEXT, rewardsT } from "../src/lib/rewardsI18n.js";
import { REDEMPTION_STATUS, REWARDS_SETTING_ID } from "../src/lib/rewards.js";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";
let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const NOW = new Date("2026-11-19T15:00:00Z");
const H = 3_600_000, D = 24 * H;

// ── 1. Pure rules ─────────────────────────────────────────────────────────────
console.log("\n1. Pure rules (src/lib/recentWinners.js)");
{
  ok("mask: 'Omar Benali' → 'Omar B.'", maskDisplayName("Omar Benali") === "Omar B.");
  ok("mask: 'Fatima Zahra Idrissi' → 'Fatima I.'", maskDisplayName("Fatima Zahra Idrissi") === "Fatima I.");
  ok("mask: demo 'Hajar N.' unchanged", maskDisplayName("Hajar N.") === "Hajar N.");
  ok("mask: Arabic 'عمر بنعلي' → 'عمر ب.'", maskDisplayName("عمر بنعلي") === "عمر ب.");
  ok("mask: one word / empty / null", maskDisplayName("Kawtar") === "Kawtar" && maskDisplayName("  ") === null && maskDisplayName(null) === null);
  ok("mask: angle brackets stripped", !/[<>]/.test(maskDisplayName("<b>Ali</b> X") || ""));

  ok("winner statuses = accepted only", JSON.stringify(WINNER_STATUSES) === JSON.stringify(["APPROVED", "PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED"]));
  for (const s of Object.values(REDEMPTION_STATUS)) {
    const exp = WINNER_STATUSES.includes(s);
    const item = realWinnerItem({ id: "x", status: s, createdAt: NOW, giftSnapshot: { name: "iPad", image: "/uploads/i.webp" }, affiliate: { name: "Omar Benali", avatarUrl: null } });
    ok(`real item for ${s}: ${exp ? "shown" : "never shown"}`, exp ? !!item : item === null);
  }
  const it = realWinnerItem({
    id: "11111111-2222-3333-4444-555555555555", status: "DELIVERED", createdAt: NOW, reference: "RW-SECRET", phone: "0600", address: "rue",
    giftSnapshot: { name: "AirPods", image: "/uploads/a.webp", pointsCost: 90 }, affiliate: { name: "Youssef Alaoui", avatarUrl: "https://cdn.example.com/y.jpg" },
  });
  ok("real item: public shape only", JSON.stringify(Object.keys(it).sort()) === JSON.stringify(["avatarKey", "avatarUrl", "demo", "giftImage", "giftName", "key", "name", "wonAt"]) && it.avatarKey === null, it);
  ok("real item: masked name, demo false, wonAt = createdAt", it.name === "Youssef A." && it.demo === false && it.wonAt === NOW.toISOString());
  ok("real item: opaque key (no request id / reference)", it.key.startsWith("r-") && !it.key.includes("1111") && !JSON.stringify(it).includes("RW-SECRET"));
  ok("real item: unsafe image URL dropped", realWinnerItem({ id: "y", status: "APPROVED", createdAt: NOW, giftSnapshot: { name: "X", image: "javascript:alert(1)" }, affiliate: {} }).giftImage === null);
  ok("real item: no gift name → skipped", realWinnerItem({ id: "z", status: "APPROVED", createdAt: NOW, giftSnapshot: {}, affiliate: {} }) === null);

  // 30 existing Top Members demo members (ids / names / photos as stored), 4 catalogue gifts
  const ANCHOR = new Date("2026-08-01T10:00:00Z");
  const names = ["Hajar N.", "Fatima Zahra P.", "Nadia L.", "Reda Q.", "Zineb J.", "Bilal C.", "Ghita O.", "Karim G.", "Ayoub F.", "Meryem H.",
    "Amine D.", "Anas Z.", "Omar T.", "Sara M.", "Mehdi S.", "Oumaima I.", "Salma B.", "Youssef A.", "Imane K.", "Hamza E.",
    "Khadija R.", "Nora K.", "Adam L.", "Lina S.", "Yassine M.", "Rim T.", "Ilyas B.", "Hiba C.", "Taha D.", "Aya E."];
  const members = names.map((name, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name, photoUrl: i % 3 ? null : `/uploads/m${i}.jpg`, createdAt: ANCHOR, until: null }));
  const gifts = [{ id: "g1", name: "iPad 10.9\"", images: ["/uploads/ipad.webp"], createdAt: ANCHOR }, { id: "g2", name: "Montre", images: [], createdAt: ANCHOR },
    { id: "g3", name: "Écouteurs", images: ["/uploads/e.webp"], createdAt: ANCHOR }, { id: "g4", name: "Clavier", images: ["/uploads/k.webp"], createdAt: ANCHOR }];
  const anchorMs = cycleAnchorMs(ANCHOR);
  const demo = demoWinners({ members, gifts, now: NOW, anchor: ANCHOR, seed: "s1" });
  const cycleNow = demoCycleOf(NOW, anchorMs);
  ok("cycles: 30 days, anchored on the Top Members start day; NOW is in cycle 3", DEMO_CYCLE_DAYS === 30 && cycleNow === 3 && demoCycleOf(anchorMs + 30 * D - 1, anchorMs) === 0 && demoCycleOf(anchorMs + 30 * D, anchorMs) === 1);
  ok("wins per member per cycle: 3 to 4 (internal rule, no admin setting)", DEMO_WINS_PER_CYCLE.min === 3 && DEMO_WINS_PER_CYCLE.max === 4);
  // full schedules of every member over 12 cycles
  let countsOk = true, insideOk = true, gapOk = true, spreadOk = true;
  const counts = new Set(); const firstDays = new Set();
  for (const m of members) {
    let prev = null;
    for (let c = 0; c < 12; c++) {
      const sch = memberCycleSchedule("s1", m.id, c, anchorMs);
      counts.add(sch.length);
      if (sch.length < 3 || sch.length > 4) countsOk = false;
      const start = anchorMs + c * 30 * D;
      for (const { at } of sch) {
        if (at < start || at >= start + 30 * D) insideOk = false;
        const dayIdx = Math.floor(at / D);
        if (prev !== null && dayIdx - prev < 2) gapOk = false; // never the same or consecutive days (also across cycles)
        prev = dayIdx;
      }
      if (c === 0) firstDays.add(Math.floor((sch[0].at - start) / D));
      const days = sch.map(({ at }) => Math.floor((at - start) / D));
      if (days[days.length - 1] - days[0] < 12) spreadOk = false; // spread over the month (first ≤ day 8, last ≥ day 20)
    }
  }
  ok("schedule: every member wins 3 or 4 times in every cycle (both occur)", countsOk && counts.has(3) && counts.has(4), [...counts]);
  ok("schedule: every win falls inside its own 30-day cycle", insideOk);
  ok("schedule: a member never wins on the same or consecutive days (12 cycles, across cycle boundaries too)", gapOk);
  ok("schedule: each member's wins are spread across the month", spreadOk);
  ok("schedule: members do not all win on the same day (first wins on ≥ 5 different days)", firstDays.size >= 5, [...firstDays]);
  ok("schedule: deterministic (same seed / member / cycle → same instants)", JSON.stringify(memberCycleSchedule("s1", members[0].id, 2, anchorMs)) === JSON.stringify(memberCycleSchedule("s1", members[0].id, 2, anchorMs)));
  ok("schedule: a new cycle gives a new distribution", JSON.stringify(memberCycleSchedule("s1", members[0].id, 2, anchorMs).map((x) => x.at - 2 * 30 * D)) !== JSON.stringify(memberCycleSchedule("s1", members[0].id, 3, anchorMs).map((x) => x.at - 3 * 30 * D)));

  const perCycle = {};
  for (const w of demo) { const c = demoCycleOf(w.wonAt, anchorMs); const k = `${w.avatarKey}|${c}`; perCycle[k] = (perCycle[k] || 0) + 1; }
  ok("demo list: current + previous cycle only, all in the past, newest first", demo.length > 0 && demo.every((w) => new Date(w.wonAt) <= NOW && demoCycleOf(w.wonAt, anchorMs) >= cycleNow - 1)
    && demo.every((w, i) => i === 0 || new Date(demo[i - 1].wonAt) >= new Date(w.wonAt)));
  ok("demo list: every member of the previous (complete) cycle won 3–4 times", members.every((m) => [3, 4].includes(perCycle[`${m.id}|${cycleNow - 1}`])));
  ok("demo list: ~2.4 demo wins / day on average with 30 members (no burst)", (() => { const prev = demo.filter((w) => demoCycleOf(w.wonAt, anchorMs) === cycleNow - 1).length; return prev >= 90 && prev <= 120; })());
  ok("demo: only the given Top Members identities (never anything else)", demo.every((w) => members.some((m) => m.id === w.avatarKey && m.name === w.name)));
  ok("demo: exact Top Members display names (never re-masked: 'Fatima Zahra P.' stays)", demo.some((w) => w.name === "Fatima Zahra P.") && !demo.some((w) => w.name === "Fatima P."));
  ok("demo: avatar = the member's own photo / colour", demo.every((w) => { const m = members.find((x) => x.id === w.avatarKey); return w.avatarUrl === (m.photoUrl || null); }));
  ok("demo: gifts from the catalogue; members receive different gifts", demo.every((w) => gifts.some((g) => g.name === w.giftName)) && new Set(demo.map((w) => w.giftName)).size === gifts.length);
  ok("demo: flagged demo, unique opaque keys", demo.every((w) => w.demo === true && /^d-[0-9a-z]+$/.test(w.key)) && new Set(demo.map((w) => w.key)).size === demo.length);
  ok("demo: refresh-stable (same input in any order → same list)", JSON.stringify(demo) === JSON.stringify(demoWinners({ members: [...members].reverse(), gifts: [...gifts].reverse(), now: NOW, anchor: ANCHOR, seed: "s1" })));
  const later = demoWinners({ members, gifts, now: new Date(NOW.getTime() + 3 * D), anchor: ANCHOR, seed: "s1" });
  ok("demo: time moves on → past wins unchanged, newer wins added on top", new Date(later[0].wonAt) > new Date(demo[0].wonAt)
    && demo.filter((w) => demoCycleOf(w.wonAt, anchorMs) === cycleNow).every((w) => later.some((x) => x.key === w.key && x.wonAt === w.wonAt && x.giftName === w.giftName)));

  // Top Members population changes (monthly refresh by the admin)
  const others = demo.filter((w) => w.avatarKey !== members[0].id);
  const without = demoWinners({ members: members.slice(1), gifts, now: NOW, anchor: ANCHOR, seed: "s1" });
  ok("refresh: removing a member never moves anyone else's wins", JSON.stringify(others) === JSON.stringify(without));
  const newcomer = { id: "99999999-0000-4000-8000-000000000001", name: "Nouveau M.", photoUrl: null, createdAt: new Date(NOW.getTime() - 5 * D), until: null };
  const withNew = demoWinners({ members: [...members, newcomer], gifts, now: NOW, anchor: ANCHOR, seed: "s1" });
  ok("refresh: adding a member never moves anyone else's wins", JSON.stringify(withNew.filter((w) => w.avatarKey !== newcomer.id)) === JSON.stringify(demo));
  ok("refresh: a member created mid-cycle only wins after its creation (no old win attached to it)", withNew.filter((w) => w.avatarKey === newcomer.id).every((w) => new Date(w.wonAt) >= newcomer.createdAt));
  const renamed = demoWinners({ members: members.map((m, i) => (i === 0 ? { ...m, name: "Hajar Renamed" } : m)), gifts, now: NOW, anchor: ANCHOR, seed: "s1" });
  ok("refresh: a renamed member keeps its schedule (same id → same wins, new name)", JSON.stringify(renamed.map((w) => [w.key, w.wonAt])) === JSON.stringify(demo.map((w) => [w.key, w.wonAt])) && renamed.some((w) => w.name === "Hajar Renamed"));
  const cut = new Date(NOW.getTime() - 10 * D);
  const archived = demoWinners({ members: members.map((m, i) => (i === 0 ? { ...m, until: cut } : m)), gifts, now: NOW, anchor: ANCHOR, seed: "s1" });
  ok("refresh: an archived / disabled member keeps its past wins and stops winning at that date", archived.filter((w) => w.avatarKey === members[0].id).every((w) => new Date(w.wonAt) < cut)
    && JSON.stringify(archived.filter((w) => w.avatarKey !== members[0].id)) === JSON.stringify(others)
    && JSON.stringify(archived.filter((w) => w.avatarKey === members[0].id)) === JSON.stringify(demo.filter((w) => w.avatarKey === members[0].id && new Date(w.wonAt) < cut)));
  // ── Stable gift assignment (gifts active AT the win instant, from the gift audit trail) ──
  const T = (days) => new Date(NOW.getTime() - days * D);
  const ev = (action, daysAgo, after, before = null) => ({ action, createdAt: T(daysAgo), after, before });
  const ON = { isActive: true, archivedAt: null }, OFF = { isActive: false, archivedAt: null }, ARCH = { isActive: false, archivedAt: "x" };
  ok("intervals: created active → [created, ∞)", JSON.stringify(giftActiveIntervals({ createdAt: T(10) }, [ev("GIFT_CREATE", 10, ON)])) === JSON.stringify([[T(10).getTime(), null]].map(([x]) => [x, Infinity])));
  ok("intervals: created as a draft, activated 5 days ago, archived 2 days ago → [−5 d, −2 d)", JSON.stringify(giftActiveIntervals({ createdAt: T(10) }, [ev("GIFT_CREATE", 10, OFF), ev("GIFT_ACTIVATE", 5, ON, OFF), ev("GIFT_ARCHIVE", 2, ARCH, ON)])) === JSON.stringify([[T(5).getTime(), T(2).getTime()]]));
  ok("intervals: deactivate / re-activate → two periods; stock / text edits ignored", JSON.stringify(giftActiveIntervals({ createdAt: T(20) }, [ev("GIFT_CREATE", 20, ON), ev("GIFT_UPDATE", 15, { name: "x" }), ev("GIFT_DEACTIVATE", 12, OFF, ON), ev("GIFT_STOCK_ADJUST", 11, {}), ev("GIFT_ACTIVATE", 8, ON, OFF)]))
    === JSON.stringify([[T(20).getTime(), T(12).getTime()], [T(8).getTime(), Infinity]]));
  ok("intervals: never-activated draft → none; no audit event → current state since creation", giftActiveIntervals({ createdAt: T(9) }, [ev("GIFT_CREATE", 9, OFF)]).length === 0
    && JSON.stringify(giftActiveIntervals({ createdAt: T(9), isActive: true, archivedAt: null }, [])) === JSON.stringify([[T(9).getTime(), Infinity]])
    && giftActiveIntervals({ createdAt: T(9), isActive: false, archivedAt: null }, []).length === 0);
  ok("intervals: history older than the audit trail → state before the first event", JSON.stringify(giftActiveIntervals({ createdAt: T(30) }, [ev("GIFT_DEACTIVATE", 4, OFF, ON)])) === JSON.stringify([[T(30).getTime(), T(4).getTime()]]));
  ok("gift state actions = the only ways a gift's active state changes", JSON.stringify(GIFT_STATE_ACTIONS) === JSON.stringify(["GIFT_CREATE", "GIFT_ACTIVATE", "GIFT_DEACTIVATE", "GIFT_ARCHIVE", "GIFT_RESTORE"]));

  const withIntervals = (list) => list.map((g) => ({ ...g, activeIntervals: giftActiveIntervals(g, g.events) }));
  const base = withIntervals(gifts.map((g) => ({ ...g, events: [{ action: "GIFT_CREATE", createdAt: ANCHOR, after: ON }] })));
  const run = (cat, now = NOW) => demoWinners({ members, gifts: cat, now, anchor: ANCHOR, seed: "s1" });
  const ref = run(base);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const pastOf = (list, t) => list.filter((w) => new Date(w.wonAt) < t);
  // 1. a new gift added + activated today
  const added = run(withIntervals([...base, { id: "g0", name: "Nouveau cadeau", images: [], createdAt: T(0.5), events: [ev("GIFT_CREATE", 0.5, ON)] }]));
  ok("catalogue: adding a gift NEVER changes any earlier win (gift, member, date)", same(pastOf(added, T(0.5)), pastOf(ref, T(0.5))) && pastOf(ref, T(0.5)).length > 50);
  ok("catalogue: the new gift is used only for wins after it was offered", added.filter((w) => w.giftName === "Nouveau cadeau").every((w) => new Date(w.wonAt) >= T(0.5)));
  // 2. an old draft activated today
  const draftLater = run(withIntervals([...base, { id: "g5", name: "Ancien brouillon", images: [], createdAt: T(50), events: [ev("GIFT_CREATE", 50, OFF), ev("GIFT_ACTIVATE", 1, ON, OFF)] }]));
  ok("catalogue: a draft created long ago and activated today changes no earlier win", same(pastOf(draftLater, T(1)), pastOf(ref, T(1))));
  ok("catalogue: a never-activated draft is never assigned", run(withIntervals([...base, { id: "g6", name: "Brouillon", images: [], createdAt: T(40), events: [ev("GIFT_CREATE", 40, OFF)] }])).every((w) => w.giftName !== "Brouillon"));
  // 3. deactivating / archiving a gift today
  for (const [action, after] of [["GIFT_DEACTIVATE", OFF], ["GIFT_ARCHIVE", ARCH]]) {
    const cut = withIntervals(base.map((g) => (g.id === "g2" ? { ...g, events: [...g.events, ev(action, 1, after, ON)] } : g)));
    const r = run(cut);
    ok(`catalogue: ${action === "GIFT_ARCHIVE" ? "archiving" : "deactivating"} a gift keeps it on every earlier win, and only later wins stop using it`, same(pastOf(r, T(1)), pastOf(ref, T(1))) && pastOf(ref, T(1)).some((w) => w.giftName === "Montre") && r.filter((w) => new Date(w.wonAt) >= T(1)).every((w) => w.giftName !== "Montre"));
  }
  // 4. renaming a gift / renaming a member
  const renamedGift = run(base.map((g) => (g.id === "g1" ? { ...g, name: "iPad (nouveau nom)" } : g)));
  ok("rename a gift: same gift on the same wins (only its displayed name changes)", renamedGift.every((w, k) => (ref[k].giftName === 'iPad 10.9"' ? w.giftName === "iPad (nouveau nom)" : w.giftName === ref[k].giftName) && w.wonAt === ref[k].wonAt));
  const renamedMember = run(base).map((w) => w); // members unchanged here; member rename covered below
  const rm = demoWinners({ members: members.map((m, i) => (i === 0 ? { ...m, name: "Hajar Renamed", photoUrl: "/uploads/new.jpg" } : m)), gifts: base, now: NOW, anchor: ANCHOR, seed: "s1" });
  ok("rename / new avatar of a member: same dates and same gifts", same(rm.map((w) => [w.key, w.wonAt, w.giftName]), renamedMember.map((w) => [w.key, w.wonAt, w.giftName])));
  // 5. no gift offered at an instant → no win then
  const late = run(withIntervals(gifts.map((g) => ({ ...g, createdAt: T(6), events: [ev("GIFT_CREATE", 6, ON)] }))));
  ok("no gift offered yet → no demo win at that time", late.length > 0 && late.every((w) => new Date(w.wonAt) >= T(6)));
  ok("the gift does not depend on the catalogue order", same(run([base[2], base[0], base[3], base[1]]), ref));

  // 6. PROPERTY: replay a random catalogue history day by day; a win once shown never changes afterwards
  let rnd = 12345; const rand = () => ((rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const hist = []; // { id, name, createdAt, events }
  for (let k = 0; k < 9; k++) {
    const created = 70 - Math.floor(rand() * 60);
    const events = [ev("GIFT_CREATE", created, rand() < 0.6 ? ON : OFF)];
    let state = events[0].after;
    for (let d = created - 1; d > -40; d--) {
      if (rand() < 0.06) {
        const opts = state.archivedAt ? [["GIFT_RESTORE", OFF]] : state.isActive ? [["GIFT_DEACTIVATE", OFF], ["GIFT_ARCHIVE", ARCH]] : [["GIFT_ACTIVATE", ON], ["GIFT_ARCHIVE", ARCH]];
        const [action, after] = opts[Math.floor(rand() * opts.length)];
        events.push(ev(action, d - rand() * 0.9, after, state)); state = after;
      }
    }
    hist.push({ id: `h${k}`, name: `Cadeau ${k}`, images: [], createdAt: T(created), events });
  }
  const catalogueAt = (t) => hist.filter((g) => g.createdAt <= t).map((g) => {
    const evs = g.events.filter((e) => e.createdAt <= t);
    const cur = evs[evs.length - 1].after;
    return { id: g.id, name: g.name, images: [], createdAt: g.createdAt, isActive: cur.isActive, archivedAt: cur.archivedAt, activeIntervals: giftActiveIntervals({ ...g, ...cur }, evs) };
  });
  const snapshots = [];
  for (let d = 45; d >= -39; d -= 3) { const t = T(d); snapshots.push({ t, list: run(catalogueAt(t), t) }); }
  let stable = true, seenChanges = 0, compared = 0;
  for (let a = 0; a < snapshots.length; a++) for (let b2 = a + 1; b2 < snapshots.length; b2++) {
    const later = new Map(snapshots[b2].list.map((w) => [w.key, w]));
    for (const w of snapshots[a].list) {
      const x = later.get(w.key);
      if (!x) { if (demoCycleOf(w.wonAt, anchorMs) >= demoCycleOf(snapshots[b2].t, anchorMs) - 1) stable = false; continue; } // only ageing out may remove it
      compared++;
      if (x.wonAt !== w.wonAt || x.giftName !== w.giftName || x.name !== w.name) { stable = false; seenChanges++; }
    }
  }
  const evCount = hist.reduce((n, g) => n + g.events.length, 0);
  ok(`property: over 85 days of random catalogue changes (${evCount} gift events, ${snapshots.length} snapshots), no past demo win ever changed gift, member or date`, stable && compared > 1000 && evCount > 20, { seenChanges, compared, evCount });
  ok("no members, no gifts, no anchor, or before the start → none", demoWinners({ members: [], gifts, now: NOW, anchor: ANCHOR }).length === 0 && demoWinners({ members, gifts: [], now: NOW, anchor: ANCHOR }).length === 0
    && demoWinners({ members, gifts, now: NOW, anchor: null }).length === 0 && demoWinners({ members, gifts, now: new Date(anchorMs - D), anchor: ANCHOR }).length === 0);

  const real = [it, realWinnerItem({ id: "old", status: "APPROVED", createdAt: new Date(NOW.getTime() - 20 * D), giftSnapshot: { name: "Old" }, affiliate: { name: "Old One" } })];
  const merged = mergeWinners(real, demo, MAX_WINNERS);
  ok("merge: newest first (wonAt DESC) across sources", merged.every((w, i) => i === 0 || new Date(merged[i - 1].wonAt) >= new Date(w.wonAt)));
  ok("merge: newest real winner first when it is the newest", merged[0].key === it.key);
  ok("merge: capped at MAX_WINNERS (30)", MAX_WINNERS === 30 && merged.length <= 30);
  ok("sort: ties broken by key (stable, never random)", JSON.stringify(sortWinners([{ key: "b", wonAt: "2026-01-01T00:00:00Z" }, { key: "a", wonAt: "2026-01-01T00:00:00Z" }]).map((x) => x.key)) === '["a","b"]');
  ok("hash32 deterministic", hash32("abc") === hash32("abc") && hash32("abc") !== hash32("abd"));

  const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
  const nowMs = NOW.getTime();
  const cases = [
    [30_000, "الآن", "à l'instant"], [60_000, "منذ دقيقة", "il y a 1 min"], [2 * 60_000, "منذ دقيقتين", "il y a 2 min"], [5 * 60_000, "منذ 5 دقائق", "il y a 5 min"],
    [H, "منذ ساعة", "il y a 1 h"], [2 * H, "منذ ساعتين", "il y a 2 h"], [3 * H, "منذ 3 ساعات", "il y a 3 h"], [11 * H, "منذ 11 ساعة", "il y a 11 h"],
    [D, "منذ يوم", "il y a 1 jour"], [2 * D, "منذ يومين", "il y a 2 jours"], [3 * D, "منذ 3 أيام", "il y a 3 jours"], [12 * D, "منذ 12 يومًا", "il y a 12 jours"],
  ];
  for (const [ms, ar, fr] of cases) ok(`relative ${ms / 60_000} min → "${ar}" / "${fr}"`, relativeWin(ago(ms), nowMs, "ar") === ar && relativeWin(ago(ms), nowMs, "fr") === fr, [relativeWin(ago(ms), nowMs, "ar"), relativeWin(ago(ms), nowMs, "fr")]);
  ok("relative: a future instant reads as now", relativeWin(new Date(nowMs + 5 * H).toISOString(), nowMs, "fr") === "à l'instant");
  ok("winning time HH:MM (Casablanca, one table)", /^\d{2}:\d{2}$/.test(winnerTime(NOW.toISOString())) && winnerTime("bad") === "");

  ok("per view: desktop / phone (slider ≥ 300 px) → 3", perViewFor(900) === 3 && perViewFor(324) === 3 && perViewFor(300) === 3 && perViewFor(0) === 3);
  ok("per view: narrow (320 px phone) → 2, very narrow → 1", perViewFor(280) === 2 && perViewFor(200) === 1);
  ok("pages: 7 winners × 3 → [0, 3, 4] (last page aligned to the end)", JSON.stringify(pageStarts(7, 3)) === "[0,3,4]");
  ok("pages: 9 × 3 → [0, 3, 6]; 3 × 3 → [0]; 2 × 3 → [0]; 0 → [0]", JSON.stringify(pageStarts(9, 3)) === "[0,3,6]" && JSON.stringify(pageStarts(3, 3)) === "[0]" && JSON.stringify(pageStarts(2, 3)) === "[0]" && JSON.stringify(pageStarts(0, 3)) === "[0]");
  let everyOnce = true, monotonic = true;
  for (let n = 1; n <= 40; n++) for (const pv of [1, 2, 3]) {
    const starts = pageStarts(n, pv);
    const seen = new Set();
    starts.forEach((s, i) => { for (let k = s; k < Math.min(n, s + pv); k++) seen.add(k); if (i && s <= starts[i - 1]) monotonic = false; });
    if (seen.size !== n) everyOnce = false;
    // no winner re-shown before every winner was shown: page i only overlaps the previous page at the end
    starts.forEach((s, i) => { if (i && i < starts.length - 1 && s !== starts[i - 1] + pv) everyOnce = false; });
  }
  ok("pages: every winner shown in one cycle, in order, for n = 1…40 and 1/2/3 per view", everyOnce && monotonic);
}

// ── 2. Service (read-only fake db) ──────────────────────────────────────────────
console.log("\n2. Service — read only, sources, ordering, switches");
function fakeDb({ rewardsEnabled = true, engine = { enabled: true, initializedAt: new Date(NOW.getTime() - 30 * D), resumedAt: null }, redemptions = [], members, gifts, affiliates } = {}) {
  const calls = [];
  const write = (model, op) => () => { throw new Error(`WRITE ${model}.${op} — must never happen`); };
  const model = (name, impl) => new Proxy(impl, {
    get: (t, op) => (op in t ? (...a) => { calls.push([name, op, a[0]]); return t[op](...a); } : (["create", "update", "upsert", "delete", "deleteMany", "updateMany", "createMany"].includes(op) ? write(name, op) : undefined)),
  });
  const db = {
    calls,
    setting: model("setting", { findUnique: async ({ where }) => (where.id === REWARDS_SETTING_ID ? { id: REWARDS_SETTING_ID, data: { enabled: rewardsEnabled } } : null) }),
    rewardRedemption: model("rewardRedemption", {
      findMany: async ({ where, take }) => redemptions
        .filter((r) => where.status.in.includes(r.status))
        .sort((a, b) => (b.createdAt - a.createdAt) || (b.id < a.id ? -1 : 1))
        .slice(0, take)
        .map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt, giftSnapshot: r.giftSnapshot, affiliate: { name: r.name, avatarUrl: r.avatarUrl ?? null } })),
    }),
    demoCompEngine: model("demoCompEngine", { findUnique: async () => engine }),
    demoCompMember: model("demoCompMember", {
      findMany: async () => members ?? [
        { id: "m1", name: "Hajar N.", photoUrl: "/uploads/h.jpg", active: true, archivedAt: null, createdAt: new Date(NOW.getTime() - 40 * D) },
        { id: "m2", name: "Reda Q.", photoUrl: null, active: true, archivedAt: null, createdAt: new Date(NOW.getTime() - 40 * D) },
        { id: "m3", name: "Off D.", photoUrl: null, active: false, archivedAt: null, createdAt: new Date(NOW.getTime() - 40 * D) },
        { id: "m4", name: "Gone A.", photoUrl: null, active: false, archivedAt: new Date(NOW.getTime() - 3 * D), createdAt: new Date(NOW.getTime() - 40 * D) },
      ],
      findFirst: async () => ({ createdAt: new Date(NOW.getTime() - 40 * D) }),
    }),
    demoCompMemberVersion: model("demoCompMemberVersion", { findMany: async () => [{ memberId: "m3", effectiveFrom: new Date(NOW.getTime() - 20 * D) }] }),
    rewardGift: model("rewardGift", { findMany: async () => gifts ?? [
      { id: "g1", name: "iPad", images: ["/uploads/ipad.webp"], isActive: true, archivedAt: null, createdAt: new Date(NOW.getTime() - 60 * D) },
      { id: "gOld", name: "Archived Gift", images: [], isActive: false, archivedAt: new Date(NOW.getTime() - 5 * D), createdAt: new Date(NOW.getTime() - 60 * D) },
      { id: "gDraft", name: "Draft Gift", images: [], isActive: false, archivedAt: null, createdAt: new Date(NOW.getTime() - 60 * D) },
    ] }),
    rewardAuditLog: model("rewardAuditLog", { findMany: async () => [
      { entityId: "g1", action: "GIFT_CREATE", before: null, after: { isActive: true, archivedAt: null }, createdAt: new Date(NOW.getTime() - 60 * D) },
      { entityId: "gOld", action: "GIFT_CREATE", before: null, after: { isActive: true, archivedAt: null }, createdAt: new Date(NOW.getTime() - 60 * D) },
      { entityId: "gOld", action: "GIFT_ARCHIVE", before: { isActive: true, archivedAt: null }, after: { isActive: false, archivedAt: "x" }, createdAt: new Date(NOW.getTime() - 5 * D) },
      { entityId: "gDraft", action: "GIFT_CREATE", before: null, after: { isActive: false, archivedAt: null }, createdAt: new Date(NOW.getTime() - 60 * D) },
    ] }),
    affiliate: model("affiliate", { findUnique: async ({ where }) => (affiliates ?? { A: { isActive: true }, OFF: { isActive: false } })[where.id] ?? null }),
    pointsLedger: model("rewardPointsLedger", {}),
  };
  return db;
}
const R = (id, status, hoursAgo, name = "Omar Benali") => ({ id, status, createdAt: new Date(NOW.getTime() - hoursAgo * H), giftSnapshot: { name: `Gift ${id}`, image: `/uploads/${id}.webp` }, name });
{
  __resetRecentWinnersCache();
  let db = fakeDb({ rewardsEnabled: false, redemptions: [R("a", "DELIVERED", 1)] });
  let res = await getRecentWinners({ db, now: NOW, useCache: false });
  ok("rewards program OFF → { enabled: false, winners: [] } (section hidden)", res.enabled === false && res.winners.length === 0);
  ok("rewards OFF → no redemption / demo query at all", !db.calls.some(([m]) => m !== "setting"));

  const reds = [R("p", "PENDING_REVIEW", 0.5), R("rj", "REJECTED", 0.6), R("c", "CANCELLED", 0.7), R("rt", "RETURNED", 0.8),
    R("a1", "APPROVED", 1), R("d1", "DELIVERED", 5), R("s1", "SHIPPED", 3), R("t1", "IN_TRANSIT", 30), R("pr", "PREPARING", 2)];
  db = fakeDb({ redemptions: reds, engine: { enabled: false } });
  res = await getRecentWinners({ db, now: NOW, useCache: false });
  ok("engine OFF → real winners only (no demo)", res.enabled && res.winners.every((w) => !w.demo));
  ok("real: only accepted statuses (pending / rejected / cancelled / returned never shown)", res.winners.length === 5 && !res.winners.some((w) => /Gift (p|rj|c|rt)$/.test(w.giftName)), res.winners.map((w) => w.giftName));
  ok("real: newest first (createdAt DESC)", JSON.stringify(res.winners.map((w) => w.giftName)) === JSON.stringify(["Gift a1", "Gift pr", "Gift s1", "Gift d1", "Gift t1"]), res.winners.map((w) => w.giftName));
  const q = db.calls.find(([m, op]) => m === "rewardRedemption" && op === "findMany")[2];
  ok("real query: status IN accepted, ORDER BY createdAt DESC, id DESC, LIMIT 30", JSON.stringify(q.where) === JSON.stringify({ status: { in: WINNER_STATUSES } }) && JSON.stringify(q.orderBy) === JSON.stringify([{ createdAt: "desc" }, { id: "desc" }]) && q.take === 30);
  ok("real query: selects only name + avatar of the affiliate (no phone / address / email)", JSON.stringify(q.select.affiliate) === JSON.stringify({ select: { name: true, avatarUrl: true } }) && !("phone" in q.select) && !("address" in q.select) && !("fullName" in q.select));
  ok("engine OFF → demo members / gifts never queried", !db.calls.some(([m]) => m === "demoCompMember" || m === "rewardGift"));

  db = fakeDb({ redemptions: [R("new", "APPROVED", 0.25), ...Array.from({ length: 40 }, (_, i) => R(`o${i}`, "DELIVERED", 24 * 30 + i))] });
  res = await getRecentWinners({ db, now: NOW, useCache: false });
  ok("engine ON → real + demo, newest first, ≤ 30", res.winners.length === 30 && res.winners.some((w) => w.demo) && res.winners.some((w) => !w.demo)
    && res.winners.every((w, i) => i === 0 || new Date(res.winners[i - 1].wonAt) >= new Date(w.wonAt)));
  ok("a newly recorded real win becomes the first item", res.winners[0].giftName === "Gift new" && res.winners[0].demo === false);
  ok("demo members query: current Top Members + those archived during the 2 cycles shown, limited", (() => { const c = db.calls.find(([m, op]) => m === "demoCompMember" && op === "findMany")[2]; return JSON.stringify(c.where.OR[0]) === '{"archivedAt":null}' && c.where.OR[1].archivedAt.gte instanceof Date && c.take <= 200; })());
  ok("disabled member: versions read only for disabled, non-archived members", (() => { const c = db.calls.find(([m]) => m === "demoCompMemberVersion")[2]; return JSON.stringify(c.where) === '{"memberId":{"in":["m3"]},"active":false}'; })());
  ok("disabled member stops at its switch-off date; archived member at its archive date", res.winners.filter((w) => w.avatarKey === "m3").every((w) => NOW - new Date(w.wonAt) > 20 * D) && res.winners.filter((w) => w.avatarKey === "m4").every((w) => NOW - new Date(w.wonAt) > 3 * D));
  ok("demo identities: only demo_comp_members rows (never an affiliate)", res.winners.filter((w) => w.demo).every((w) => ["m1", "m2", "m3", "m4"].includes(w.avatarKey)) && !db.calls.some(([m]) => m === "affiliate"));
  ok("demo gifts query: whole catalogue up to now (also archived: past wins keep their gift), limited", (() => { const c = db.calls.find(([m]) => m === "rewardGift")[2]; return c.where.createdAt.lte instanceof Date && !("isActive" in c.where) && c.take <= 500; })());
  ok("gift audit query: read only, gift state actions of these gifts, up to now", (() => { const c = db.calls.find(([m]) => m === "rewardAuditLog")[2]; return c.where.entityType === "reward_gift" && JSON.stringify(c.where.action.in) === JSON.stringify(GIFT_STATE_ACTIONS) && c.where.createdAt.lte instanceof Date && c.where.entityId.in.length === 3; })());
  ok("archived gift: on wins before its archive date only; never-activated draft: never", res.winners.filter((w) => w.giftName === "Archived Gift").every((w) => NOW - new Date(w.wonAt) > 5 * D) && res.winners.some((w) => w.giftName === "Archived Gift") && !res.winners.some((w) => w.giftName === "Draft Gift"));
  ok("no write of any kind (fake db throws on writes; none attempted)", !db.calls.some(([, op]) => /create|update|upsert|delete/.test(op)));

  __resetRecentWinnersCache();
  db = fakeDb({ redemptions: [R("x", "APPROVED", 1)] });
  await getRecentWinners({ db, now: NOW });
  const n1 = db.calls.length;
  await getRecentWinners({ db, now: new Date(NOW.getTime() + 1000) });
  ok("cache: a second call within 30 s does not query again", db.calls.length === n1 && RECENT_WINNERS_CACHE_MS === 30_000);
  await getRecentWinners({ db, now: new Date(NOW.getTime() + RECENT_WINNERS_CACHE_MS + 1) });
  ok("cache: refreshed after 30 s", db.calls.length > n1);
  __resetRecentWinnersCache();
}

// ── 3. Route (real withAffiliateAuth) ───────────────────────────────────────────
console.log("\n3. Route GET /api/affiliate/rewards/winners");
{
  const db = fakeDb({ redemptions: [R("x", "DELIVERED", 1)] });
  const handler = recentWinnersHandler({ db, now: () => NOW, useCache: false });
  const GET = withAffiliateAuth(handler, { db });
  const req = (token) => new Request("http://localhost/api/affiliate/rewards/winners", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const tok = (affiliateId) => signToken({ affiliateId, username: affiliateId.toLowerCase(), type: "affiliate" });
  let res = await GET(req(null), {});
  ok("no token → 401", res.status === 401);
  res = await GET(req(tok("OFF")), {});
  ok("inactive affiliate refused (middleware)", res.status === 401 || res.status === 403, res.status);
  res = await handler(req(null), {}, { affiliateId: "OFF" });
  ok("inactive affiliate → handler answers 403 AFFILIATE_INACTIVE too", res.status === 403 && (await res.json()).code === "AFFILIATE_INACTIVE");
  res = await handler(req(null), {}, { affiliateId: "GHOST" });
  ok("unknown affiliate id → 403", res.status === 403);
  res = await GET(req(tok("A")), {});
  const body = await res.json();
  ok("active affiliate → 200 { enabled, winners }", res.status === 200 && body.enabled === true && Array.isArray(body.winners) && body.winners.length > 0);
  ok("no-store cache header", /no-store/.test(res.headers.get("cache-control") || ""));
  ok("winners carry only public fields", body.winners.every((w) => JSON.stringify(Object.keys(w).sort()) === JSON.stringify(["avatarKey", "avatarUrl", "demo", "giftImage", "giftName", "key", "name", "wonAt"])));
  const route = read("src/app/api/affiliate/rewards/winners/route.js");
  ok("route: GET only, wrapped by withAffiliateAuth", /export const GET = withAffiliateAuth\(recentWinnersHandler\(\)\)/.test(route) && !/export const (POST|PUT|PATCH|DELETE)/.test(route));
  const svc = read("src/lib/services/recentWinnersService.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("service: no write call anywhere", !/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$executeRaw|\$transaction/.test(svc));
  ok("service: never imports ledger / balance / commission / withdrawal code", !/appendLedger|lockAccount|adjustPoints|affiliateSystemService|balanceProvider|withdraw/i.test(svc));
}

// ── 4. UI wiring ────────────────────────────────────────────────────────────────
console.log("\n4. UI — placement, slider, texts");
{
  const tab = read("src/app/affiliate/dashboard/RewardsTab.jsx");
  const card = tab.indexOf("{/* Header + points */}");
  const winners = tab.indexOf("<RecentWinners t={t} lang={lang} dir={dir} />");
  const subtabs = tab.indexOf("{/* Sub-tabs */}");
  const gifts = tab.indexOf('{view === "gifts" && (');
  ok("RewardsTab: Recent Winners after the points card, before the sub-tabs + gift listing", card > -1 && winners > card && subtabs > winners && gifts > subtabs);
  ok("RewardsTab: rendered once", tab.split("<RecentWinners").length === 2);
  const others = ["src/app/affiliate/dashboard/page.jsx", "src/components/demoCompetition/ugc/HomeTopUgcVideos.jsx"].filter((p) => existsSync(new URL(`../${p}`, import.meta.url)) && read(p).includes("RecentWinners"));
  ok("not on the dashboard home or other pages", others.length === 0, others);
  const c = read("src/components/rewards/RecentWinners.jsx");
  const code = c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("no 'Voir tout' / 'عرض الكل' / link / router navigation", !/Voir tout|عرض الكل|href=|<Link|useRouter|router\.push|window\.location/.test(code));
  ok("fetches only the winners endpoint", (code.match(/fetch\(/g) || []).length === 1 && c.includes('RECENT_WINNERS_URL = "/api/affiliate/rewards/winners"'));
  ok("autoplay: interval, paused on hover / focus / touch / off screen / hidden tab / reduced motion", /setInterval\([\s\S]*?AUTOPLAY_MS\)/.test(code) && /if \(pages < 2 \|\| paused \|\| !inView \|\| reduced\) return/.test(code) && /document\.hidden/.test(code) && /onMouseEnter=\{\(\) => setPaused\(true\)\}/.test(code) && /onFocus=\{\(\) => setPaused\(true\)\}/.test(code));
  ok("autoplay: after the last page back to the newest", /\(Math\.min\(p, pages - 1\) \+ 1\) % pages/.test(code));
  ok("pages from pageStarts (every winner once per cycle)", /pageStarts\(winners\.length, perView\)/.test(code));
  ok("arrows + dots + swipe (pointer events, vertical scroll kept)", /data-winners-prev/.test(c) && /data-winners-next/.test(c) && /data-winners-dot=/.test(c) && /onPointerDown=\{onPointerDown\}/.test(code) && /touchAction: "pan-y"/.test(code) && /SWIPE_PX/.test(code));
  ok("RTL: translate sign and swipe direction follow dir", /const sign = rtl \? 1 : -1/.test(code) && /\(dx < 0\) !== rtl/.test(code));
  ok("states: loading skeleton, error + retry, empty, hidden when the program is off", /data-recent-winners-loading/.test(c) && /data-recent-winners-error/.test(c) && /winners_retry/.test(c) && /data-recent-winners-empty/.test(c) && /if \(!state\.enabled\) return null/.test(code));
  ok("broken avatar / gift image → fallback (Top Members Avatar initials; gift icon via onError)", /import DemoAvatar from "@\/components\/demoCompetition\/Avatar"/.test(c) && /<DemoAvatar src=\{src\} name=\{name\} id=\{avatarKey \|\| name\}/.test(c) && /data-winner-gift-fallback/.test(c) && /onError=\{\(\) => setBroken\(true\)\}/.test(code));
  ok("card: avatar, name, gift image, gift name, gift icon, time, relative date", ["<Avatar", "<bdi>{name}</bdi>", "<GiftImage", "{w.giftName}", "data-winner-gift-icon", "winnerTime(w.wonAt)", "relativeWin(w.wonAt, nowMs, lang)"].every((s) => c.includes(s)));
  ok("no demo-winner footnote / disclaimer under the slider (removed on request)", !/hasDemo|winners_demo_note|data-recent-winners-note|role="note"/.test(code));
  ok("demo-winner footnote texts removed (FR + AR)", !("winners_demo_note" in REWARDS_TEXT.fr) && !("winners_demo_note" in REWARDS_TEXT.ar) && !read("src/lib/rewardsI18n.js").includes("بعض الفائزين المعروضين ملفات تجريبية"));
  ok("no hard-coded French / Arabic text in the component", !/[؀-ۿ]/.test(code) && !/"(Gagnants|Précédent|Suivant|Réessayer)/.test(code));

  const keys = ["winners_title", "winners_subtitle", "winners_empty", "winners_error", "winners_retry", "winners_prev", "winners_next", "winners_page", "winners_member", "winners_won"];
  ok("FR + AR texts present", keys.every((k) => REWARDS_TEXT.fr[k] && REWARDS_TEXT.ar[k]));
  ok("AR title / subtitle as specified", REWARDS_TEXT.ar.winners_title === "الفائزون مؤخراً" && REWARDS_TEXT.ar.winners_subtitle === "تعرف على آخر الأعضاء الذين ربحوا هداياهم بالنقاط!");
  ok("page label interpolates", rewardsT("fr")("winners_page", { n: 2, total: 5 }) === "Page 2 sur 5");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
