#!/usr/bin/env node
/**
 * scripts/demoChatSchedule.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3C-4 — DEMO chat date mapping, 30-day scheduler, earnings resolver and
 * schedule preview. No database, no network; `now` is always injected.
 * Proves:
 *   • Casablanca calendar maths (no 24 h arithmetic), offset changes found in
 *     the real tz data (Ramadan switch), gap/overlap wall times, another zone
 *     with DST as a stand-in for a future rule change
 *   • day 1 / day 30 / rollover, late joiners, future messages excluded,
 *     earlier cycles hidden, deterministic ordering
 *   • earnings: complete / incomplete / unavailable, zero only with proven
 *     coverage, weekly completeness, today ≥ 12:00 and provisional, commission
 *     vs revenue vs orders labels, approved placeholders only
 *   • preview: deterministic, read-only, demo tables only
 * Run: node scripts/demoChatSchedule.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";

const T = await import("../src/lib/demoChatTime.js");
const S = await import("../src/lib/demoChatSchedule.js");
const EA = await import("../src/lib/demoChatEarnings.js");
const demo = await import("../src/lib/services/demoService.js");
const svc = await import("../src/lib/services/demoChatService.js");
const { PROFILE_META_PREFIX } = await import("../src/lib/demoProfileValidation.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rejects = (fn) => Promise.resolve().then(fn).then(() => null, (e) => e);
const CASA = T.CHAT_TIMEZONE;
const at = (date, time) => T.zonedTimeToUtc(date, time, CASA).ms; // Casablanca wall time → instant
const H = 3_600_000;

// Offset changes in the runtime's tz data (found, not hard-coded).
function transitions(tz, fromY, toY) {
  const out = []; let prev = T.offsetMinutes(Date.UTC(fromY, 0, 1), tz);
  for (let t = Date.UTC(fromY, 0, 1); t < Date.UTC(toY, 0, 1); t += H) { const o = T.offsetMinutes(t, tz); if (o !== prev) { out.push({ ms: t, from: prev, to: o }); prev = o; } }
  return out;
}

// ── 1. Calendar & time-zone maths ─────────────────────────────────────────────
console.log("\n1. Calendar and time zones");
{
  ok("date keys are strict (no 2026-02-30, no 2026-2-3)", T.isDateKey("2028-02-29") && !T.isDateKey("2026-02-29") && !T.isDateKey("2026-02-30") && !T.isDateKey("2026-2-3"));
  ok("calendar addDays across month / year / leap day", T.addDays("2026-01-31", 1) === "2026-02-01" && T.addDays("2026-12-31", 1) === "2027-01-01" && T.addDays("2028-02-28", 1) === "2028-02-29" && T.addDays("2026-03-01", -1) === "2026-02-28");
  ok("daysBetween is whole calendar days", T.daysBetween("2026-02-01", "2026-03-03") === 30 && T.daysBetween("2026-03-03", "2026-02-01") === -30);
  ok("Casablanca local parts of an instant (UTC+1 in October 2026)", T.localParts(Date.UTC(2026, 9, 24, 10, 0), CASA).time === "11:00" && T.localDateKey(Date.UTC(2026, 9, 24, 23, 30), CASA) === "2026-10-25");
  ok("process time zone untouched (Intl resolves explicitly)", Intl.DateTimeFormat().resolvedOptions().timeZone === (process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone));

  const tr = transitions(CASA, 2026, 2027);
  const back = tr.find((x) => x.to < x.from); const fwd = tr.find((x) => x.to > x.from);
  ok(`real tz data has Casablanca's 2026 offset changes (${tr.map((x) => `${new Date(x.ms).toISOString().slice(0, 10)} ${x.from}→${x.to}`).join(", ")})`, !!back && !!fwd);
  const backDay = T.localDateKey(back.ms, CASA); const fwdDay = T.localDateKey(fwd.ms, CASA);
  ok(`fall-back day ${backDay} lasts 25 h; spring-forward day ${fwdDay} lasts 23 h (local days are not 24 h)`,
    T.localDayStart(T.addDays(backDay, 1)) - T.localDayStart(backDay) === 25 * H && T.localDayStart(T.addDays(fwdDay, 1)) - T.localDayStart(fwdDay) === 23 * H);
  const repeated = T.localParts(back.ms - 30 * 60_000, CASA).time; // a wall time that occurs twice
  const ov = T.zonedTimeToUtc(backDay, repeated, CASA);
  ok(`ambiguous ${backDay} ${repeated} → earlier instant, flagged 'overlap'`, ov.adjustment === "overlap" && ov.ms === back.ms - 30 * 60_000);
  const skipped = T.localParts(fwd.ms - 30 * 60_000, CASA); // half an hour before the jump, in the OLD offset
  const missing = `${String((skipped.hour + 1) % 24).padStart(2, "0")}:${String(skipped.minute).padStart(2, "0")}`;
  const gap = T.zonedTimeToUtc(fwdDay, missing, CASA);
  ok(`non-existent ${fwdDay} ${missing} → first instant after the gap, flagged 'gap'`, gap.adjustment === "gap" && gap.ms === fwd.ms && T.localParts(gap.ms, CASA).time > missing);
  ok("normal wall time round-trips with no adjustment", (() => { const r = T.zonedTimeToUtc("2026-10-24", "09:15", CASA); return r.adjustment === null && T.localParts(r.ms, CASA).time === "09:15"; })());
  // Stand-in for a future rule change: the same code on a zone with summer time.
  const paris = T.zonedTimeToUtc("2026-03-29", "02:30", "Europe/Paris");
  const parisOv = T.zonedTimeToUtc("2026-10-25", "02:30", "Europe/Paris");
  ok("same code handles another zone's DST (gap → 03:00, overlap → earlier)", paris.adjustment === "gap" && T.localParts(paris.ms, "Europe/Paris").time === "03:00" && parisOv.adjustment === "overlap" && parisOv.ms === Date.UTC(2026, 9, 25, 0, 30));
}

// ── 2. 30-day scheduler ───────────────────────────────────────────────────────
console.log("\n2. 30-day cycles, late joiners, future messages");
const STEPS = [
  { id: "s01a", day: 1, time: "09:00", position: 0, type: "text", text: "Bienvenue" },
  { id: "s01b", day: 1, time: "09:00", position: 1, type: "text", text: "Deuxième" },
  { id: "s01c", day: 1, time: "21:00", position: 0, type: "text", text: "Bonne nuit" },
  { id: "s02a", day: 2, time: "08:00", position: 0, type: "text", text: "Jour 2 matin" },
  { id: "s02b", day: 2, time: "18:00", position: 0, type: "text", text: "Jour 2 soir" },
  { id: "s15", day: 15, time: "12:30", position: 0, type: "text", text: "Mi-parcours" },
  { id: "s30", day: 30, time: "23:59", position: 0, type: "text", text: "Fin" },
];
const ANCHOR = "2026-10-01";
{
  const vis = (date, time) => S.visibleMessages({ steps: STEPS, anchorDate: ANCHOR, nowMs: at(date, time) });
  ok("before day 1 → not started, nothing visible", !vis("2026-09-30", "23:59").position.started && vis("2026-09-30", "23:59").messages.length === 0);
  ok("day 1 08:59 → nothing yet (09:00 messages are in the future)", vis("2026-10-01", "08:59").messages.length === 0);
  const d1 = vis("2026-10-01", "09:00");
  ok("day 1 09:00 → both 09:00 messages, ordered by position", d1.messages.map((m) => m.stepId).join(",") === "s01a,s01b" && d1.position.day === 1);
  const d2 = vis("2026-10-02", "12:00");
  ok("day 2 12:00 → all of day 1 + day 2 morning; 18:00 still hidden", d2.messages.map((m) => m.stepId).join(",") === "s01a,s01b,s01c,s02a");
  ok("original timestamps (Casablanca wall time of the step's own day)", d2.messages.every((m) => T.localParts(m.scheduledAtMs, CASA).time === m.time) && d2.messages[0].date === "2026-10-01" && d2.messages[3].date === "2026-10-02");
  const late = vis("2026-10-16", "10:00");
  ok("late joiner on day 16 → day 1 … now (day 15 included), each with its original date", late.messages.map((m) => m.stepId).join(",") === "s01a,s01b,s01c,s02a,s02b,s15" && late.messages.find((m) => m.stepId === "s15").date === "2026-10-15" && late.position.day === 16);
  ok("never a future message (all ≤ now, day 30 hidden on day 16)", late.messages.every((m) => m.scheduledAtMs <= at("2026-10-16", "10:00")) && !late.messages.some((m) => m.stepId === "s30"));
  const d30 = vis("2026-10-30", "23:59");
  ok("day 30 23:59 → whole cycle visible (day 30 = anchor + 29)", d30.position.day === 30 && d30.messages.length === STEPS.length && d30.messages.at(-1).date === "2026-10-30");
  const roll = vis("2026-10-31", "08:30");
  ok("day 31 = rollover → cycle 2 day 1; previous cycle hidden", roll.position.loopIndex === 1 && roll.position.day === 1 && roll.position.previousCycles === 1 && roll.messages.length === 0);
  const roll2 = vis("2026-10-31", "09:30");
  ok("cycle 2 day 1 09:30 → only cycle-2 messages, dated 2026-10-31", roll2.messages.map((m) => `${m.loopIndex}:${m.stepId}`).join(",") === "1:s01a,1:s01b" && roll2.messages.every((m) => m.date === "2026-10-31"));
  ok("cycle 3 starts on day 61", S.cyclePosition(ANCHOR, at("2026-11-30", "00:00")).loopIndex === 2 && S.cyclePosition(ANCHOR, at("2026-11-29", "23:59")).day === 30);
  ok("deterministic: same inputs → identical output", JSON.stringify(vis("2026-10-16", "10:00")) === JSON.stringify(vis("2026-10-16", "10:00")));
  ok("input step order does not matter", JSON.stringify(S.visibleMessages({ steps: [...STEPS].reverse(), anchorDate: ANCHOR, nowMs: at("2026-10-16", "10:00") }).messages.map((m) => m.stepId)) === JSON.stringify(late.messages.map((m) => m.stepId)));

  // A cycle spanning both offset changes: every message keeps its wall time.
  const tr = transitions(CASA, 2026, 2027); const back = tr.find((x) => x.to < x.from);
  const anchor2 = T.addDays(T.localDateKey(back.ms, CASA), -10);
  const daily = Array.from({ length: 30 }, (_, i) => ({ id: `d${i + 1}`, day: i + 1, time: "09:00", position: 0, type: "text", text: "x" }));
  const all = S.visibleMessages({ steps: daily, anchorDate: anchor2, nowMs: at(T.addDays(anchor2, 29), "23:00") }).messages;
  const gaps = new Set(all.slice(1).map((m, i) => (m.scheduledAtMs - all[i].scheduledAtMs) / H));
  ok(`cycle across the ${T.localDateKey(back.ms, CASA)} offset change: always 09:00 local (instants 23/24/25 h apart: ${[...gaps].sort().join("/")} h)`, all.length === 30 && all.every((m) => T.localParts(m.scheduledAtMs, CASA).time === "09:00") && gaps.has(25));
  const fwd = tr.find((x) => x.to > x.from); const fwdDay = T.localDateKey(fwd.ms, CASA);
  const skippedLocal = T.localParts(fwd.ms - 30 * 60_000, CASA);
  const gapTime = `${String((skippedLocal.hour + 1) % 24).padStart(2, "0")}:${String(skippedLocal.minute).padStart(2, "0")}`;
  const g = S.visibleMessages({ steps: [{ id: "g", day: 1, time: gapTime, position: 0, type: "text", text: "x" }], anchorDate: fwdDay, nowMs: at(fwdDay, "12:00") }).messages[0];
  ok(`step at a skipped wall time (${fwdDay} ${gapTime}) is delivered right after the gap, flagged`, g.timeAdjustment === "gap" && g.scheduledAtMs === fwd.ms);
  ok("invalid anchor / day rejected", (() => { try { S.cyclePosition("2026-13-01", 0); return false; } catch { return true; } })() && (() => { try { S.messageDate(ANCHOR, 0, 31); return false; } catch { return true; } })());
}

// ── 3. Earnings resolver ──────────────────────────────────────────────────────
console.log("\n3. Earnings: complete / incomplete / unavailable");
const utc = (key) => new Date(`${key}T00:00:00.000Z`);
const fullCov = (key, gapSec = 30) => ({ day: utc(key), firstTickAt: new Date(utc(key).getTime() + 20_000), lastTickAt: new Date(utc(key).getTime() + 24 * H - 20_000), tickCount: 4000, maxGapSec: gapSec });
// Participation evidence (Phase 3C-5): by default the profile took part in every covered day.
const tookPart = (coverage, id = "p1") => Object.fromEntries(coverage.map((c) => [c.day.toISOString().slice(0, 10), [id]]));
const row = (id, key, orders, revenue) => ({ id, date: utc(key), orders, revenue, commission: Math.round(revenue * 0.05 * 100) / 100 });
{
  const NOW = at("2026-10-20", "15:00"); // message dates below are ≤ 2026-10-20
  const ctx = (history, coverage = [], markers = {}, extra = {}) => EA.buildEarningsContext({ history, coverage, participants: tookPart(coverage), profileId: "p1", markers, nowMs: NOW, profileCreatedAt: new Date("2026-01-01T00:00:00Z"), ...extra });
  const y = (c, msgDate = "2026-10-20") => EA.resolvePeriod(c, "yesterday", msgDate);

  let r = y(ctx([row("h1", "2026-10-19", 3, 600)], [fullCov("2026-10-19")]));
  ok("row + full coverage → complete (commission 30.00, orders 3, revenue 600)", r.status === "complete" && r.reason === "observed" && r.commission === 30 && r.orders === 3 && r.revenue === 600);
  r = y(ctx([row("h1", "2026-10-19", 3, 600)]));
  ok("row without coverage → INCOMPLETE (value may be partial)", r.status === "incomplete" && r.reason === "coverage_not_proven");
  r = y(ctx([], [fullCov("2026-10-19")]));
  ok("no row + full coverage → complete ZERO", r.status === "complete" && r.reason === "observed_zero" && r.commission === 0 && r.orders === 0);
  r = y(ctx([]));
  ok("no row + no coverage → UNAVAILABLE (not zero)", r.status === "unavailable" && r.reason === "no_row_coverage_not_proven" && r.commission === undefined);
  ok("coverage with a 10-minute gap → not proven → unavailable", y(ctx([], [fullCov("2026-10-19", 600)])).status === "unavailable");
  ok("coverage starting at 02:00 UTC → not proven", y(ctx([], [{ ...fullCov("2026-10-19"), firstTickAt: new Date(utc("2026-10-19").getTime() + 2 * H) }])).status === "unavailable");
  ok("coverage ending at 20:00 UTC → not proven", y(ctx([], [{ ...fullCov("2026-10-19"), lastTickAt: new Date(utc("2026-10-19").getTime() + 20 * H) }])).status === "unavailable");
  ok("profile created during the day → unavailable even with coverage", y(ctx([], [fullCov("2026-10-19")], {}, { profileCreatedAt: new Date("2026-10-19T09:00:00Z") })).reason === "profile_created_after_day_start");
  ok("PARTICIPATION: full coverage but profile not in that day's participants → unavailable (never zero)",
    y(ctx([], [fullCov("2026-10-19")], {}, { participants: { "2026-10-19": ["someone-else"] } })).reason === "profile_participation_not_proven");
  ok("PARTICIPATION: no participants row for the day → unavailable", y(ctx([], [fullCov("2026-10-19")], {}, { participants: {} })).status === "unavailable");
  ok("PARTICIPATION: row + coverage but profile dropped out (inactive part of the day) → incomplete", y(ctx([row("h1", "2026-10-19", 3, 600)], [fullCov("2026-10-19")], {}, { participants: { "2026-10-19": [] } })).status === "incomplete");
  ok("PARTICIPATION: no profileId given → nothing can be proven", y(ctx([], [fullCov("2026-10-19")], {}, { profileId: null })).status === "unavailable");
  ok("admin-edited row → complete (curated)", y(ctx([row("h9", "2026-10-19", 2, 300)], [], { historyEdits: { h9: { at: "x" } } })).reason === "admin_edited");
  ok("admin-backfilled day → complete (curated)", y(ctx([row("h8", "2026-10-19", 1, 150)], [], { backfilledDays: { "2026-10-19": true } })).reason === "admin_backfilled");
  ok("two rows for one day → unavailable (no guessing)", y(ctx([row("a", "2026-10-19", 1, 100), row("b", "2026-10-19", 2, 200)], [fullCov("2026-10-19")])).reason === "duplicate_history_rows");
  ok("row not at 00:00 UTC (other server TZ) → that day and the next are unavailable",
    y(ctx([{ ...row("tz", "2026-10-18", 1, 100), date: new Date("2026-10-18T23:00:00Z") }], [fullCov("2026-10-19")])).reason === "ambiguous_history_rows");
  const night = EA.buildEarningsContext({ history: [], coverage: [fullCov("2026-10-19")], participants: tookPart([fullCov("2026-10-19")]), profileId: "p1", nowMs: at("2026-10-20", "00:30"), profileCreatedAt: null });
  ok("bucket not finished at `now` (00:30 Casablanca = 23:30 UTC) → unavailable", EA.resolvePeriod(night, "yesterday", "2026-10-20").reason === "period_not_finished");

  // Week = the 7 days before the message date; all must be complete.
  const days = Array.from({ length: 7 }, (_, i) => T.addDays("2026-10-20", i - 7));
  const wk = EA.resolvePeriod(ctx(days.map((k, i) => row(`w${i}`, k, i + 1, 100 * (i + 1))), days.map((k) => fullCov(k))), "week", "2026-10-20");
  ok(`week complete → sums over ${wk.from} … ${wk.to} (orders 28, commission 140.00)`, wk.status === "complete" && wk.from === "2026-10-13" && wk.to === "2026-10-19" && wk.orders === 28 && wk.commission === 140 && wk.revenue === 2800);
  const wkZero = EA.resolvePeriod(ctx(days.slice(1).map((k, i) => row(`z${i}`, k, 1, 100)), days.map((k) => fullCov(k))), "week", "2026-10-20");
  ok("week with one proven-zero day → complete (zero counted)", wkZero.status === "complete" && wkZero.orders === 6);
  const wkHole = EA.resolvePeriod(ctx(days.slice(1).map((k, i) => row(`x${i}`, k, 1, 100)), days.slice(1).map((k) => fullCov(k))), "week", "2026-10-20");
  ok("week with ONE unavailable day → whole week unavailable, day listed", wkHole.status === "unavailable" && wkHole.reason === "week_incomplete" && wkHole.missingDays.length === 1 && wkHole.missingDays[0].day === "2026-10-13");
  const wkInc = EA.resolvePeriod(ctx(days.map((k, i) => row(`y${i}`, k, 1, 100)), days.slice(0, 6).map((k) => fullCov(k))), "week", "2026-10-20");
  ok("week with one incomplete day → unavailable", wkInc.status === "unavailable" && wkInc.missingDays[0].status === "incomplete");

  // Today: only from 12:00 Casablanca, provisional.
  const tctx = (time, history, coverage = []) => EA.buildEarningsContext({ history, coverage, participants: tookPart(coverage), profileId: "p1", nowMs: at("2026-10-20", time), profileCreatedAt: null });
  ok("today at 11:59 → unavailable (before noon)", EA.resolvePeriod(tctx("11:59", [row("t", "2026-10-20", 2, 200)]), "today", "2026-10-20").reason === "before_noon");
  const t12 = EA.resolvePeriod(tctx("12:00", [row("t", "2026-10-20", 2, 200)]), "today", "2026-10-20");
  ok("today at 12:00 with a row → PROVISIONAL value", t12.status === "provisional" && t12.commission === 10);
  const tz0 = EA.resolvePeriod(tctx("14:00", [], [{ day: utc("2026-10-20"), firstTickAt: new Date(utc("2026-10-20").getTime() + 10_000), lastTickAt: new Date(at("2026-10-20", "14:00") - 20_000), tickCount: 900, maxGapSec: 40 }]), "today", "2026-10-20");
  ok("today, no row, coverage start→now proven → provisional ZERO", tz0.status === "provisional" && tz0.reason === "today_so_far_zero" && tz0.commission === 0);
  ok("today, no row, no coverage → unavailable", EA.resolvePeriod(tctx("14:00", []), "today", "2026-10-20").status === "unavailable");
  ok("'today' message from an earlier day → unavailable (send-time value not recorded)", EA.resolvePeriod(tctx("14:00", [row("o", "2026-10-15", 9, 900)], [fullCov("2026-10-15")]), "today", "2026-10-15").reason === "historical_snapshot_required");
  ok("unknown period → unavailable", EA.resolvePeriod(ctx([]), "month", "2026-10-20").status === "unavailable");
}

// ── 4. Rendering (approved placeholders only) ─────────────────────────────────
console.log("\n4. Rendering");
{
  const complete = { period: "yesterday", status: "complete", orders: 3, revenue: 1234.5, commission: 61.73 };
  let r = EA.renderEarningsText({ text: "Bravo ! {amount} de commission {period} ({orders} commandes)", metric: "commission", resolution: complete, locale: "fr" });
  ok(`commission (fr): "${r.text}"`, r.state === "ok" && r.text === "Bravo ! 61,73 MAD de commission hier (3 commandes)" && r.metricLabel === "commission");
  r = EA.renderEarningsText({ text: "رقم المعاملات {period}: {amount}", metric: "revenue", resolution: complete, locale: "ar" });
  ok(`revenue metric → {amount} = revenue, labelled separately (ar): "${r.text}"`, /1\u202f234,50 درهم/u.test(r.text) && r.text.includes("البارح") && r.metricLabel === "رقم المعاملات" && !r.text.includes("61,73"));
  r = EA.renderEarningsText({ text: "{orders} طلبات {period}", metric: "orders", resolution: { ...complete, period: "week" }, locale: "ar" });
  ok(`orders metric → integer count (ar): "${r.text}"`, r.text === "3 طلبات آخر 7 أيام" && r.metricLabel === "الطلبات");
  r = EA.renderEarningsText({ text: "Aujourd'hui {amount}", metric: "commission", resolution: { ...complete, period: "today", status: "provisional" }, locale: "fr" });
  ok(`provisional today is labelled: "${r.text}"`, r.state === "provisional" && r.text.endsWith("(provisoire)"));
  ok("provisional label in Darija", EA.renderEarningsText({ text: "{amount} {period}", metric: "commission", resolution: { ...complete, period: "today", status: "provisional" }, locale: "ar" }).text.endsWith("(مؤقت)"));
  const zero = EA.renderEarningsText({ text: "{amount}", metric: "commission", resolution: { period: "yesterday", status: "complete", orders: 0, revenue: 0, commission: 0 }, locale: "fr" });
  ok("proven zero renders as 0,00 MAD", zero.text === "0,00 MAD");
  for (const st of ["unavailable", "incomplete"]) {
    const u = EA.renderEarningsText({ text: "{amount} {orders}", metric: "commission", resolution: { period: "yesterday", status: st, reason: "x", orders: 5, revenue: 500, commission: 25 }, locale: "fr" });
    ok(`${st} → "data unavailable" notice, no amount and no zero`, u.state === "unavailable" && u.text === EA.LABELS.fr.unavailable && !/\d/.test(u.text));
  }
  ok("missing resolution → unavailable", EA.renderEarningsText({ text: "{amount}", metric: "commission", resolution: null }).state === "unavailable");
  ok("unapproved placeholder ({balance}, {{amount}}, stray brace) → invalid, nothing substituted", ["{amount} {balance}", "{{amount}}", "{amount} }"].every((t) => EA.renderEarningsText({ text: t, metric: "commission", resolution: complete, locale: "fr" }).state === "invalid"));
  ok("unknown locale falls back to Darija labels", EA.renderEarningsText({ text: "{period}", metric: "commission", resolution: complete, locale: "xx" }).text === "البارح");
}

// ── 5. Schedule preview (service, fake read-only DB) ──────────────────────────
console.log("\n5. Schedule preview");
function makeDb({ history = [], coverage = [], meta = null, participants = {} }) {
  const writes = []; const reads = new Set();
  const t = {
    demoChatJourney: [{ id: "j1", name: "J", description: "", status: "draft", createdAt: new Date(0), updatedAt: new Date(0) }],
    demoChatJourneyStep: [
      { id: "st1", journeyId: "j1", day: 1, time: "09:00", position: 0, type: "text", text: "Salut", assetId: null },
      { id: "st2", journeyId: "j1", day: 2, time: "13:00", position: 0, type: "earnings", text: "{amount} {period}", earningsPeriod: "yesterday", metric: "commission", assetId: null },
      { id: "st3", journeyId: "j1", day: 2, time: "13:00", position: 1, type: "earnings", text: "{amount} {period}", earningsPeriod: "today", metric: "commission", assetId: null },
      { id: "st4", journeyId: "j1", day: 2, time: "14:00", position: 0, type: "image", text: null, assetId: "a1" },
      { id: "st5", journeyId: "j1", day: 9, time: "10:00", position: 0, type: "earnings", text: "{orders} {period}", earningsPeriod: "week", metric: "orders", assetId: null },
    ],
    demoChatJourneyVersion: [{ id: "v1", journeyId: "j1", version: 1, stepsHash: "h", publishedAt: new Date(0), steps: [{ id: "st1", day: 1, time: "09:00", position: 0, type: "text", text: "Version 1" }] }],
    demoChatAsset: [{ id: "a1", kind: "image", url: "https://media.test/a1.webp", mimeType: "image/webp", formatDetected: "png", bytes: 10, width: 10, height: 10 }],
    demoAffiliate: [{ id: "p1", name: "Salma", username: "salma", isActive: true, createdAt: new Date("2026-01-01T00:00:00Z") }],
    demoEarningsHistory: history, demoSimDayCoverage: coverage,
  };
  const cond = (v, c) => (c && typeof c === "object" && !(c instanceof Date) ? (!("gte" in c) || v >= c.gte) && (!("lt" in c) || v < c.lt) : c instanceof Date ? v?.getTime?.() === c.getTime() : v === c);
  const match = (r, w = {}) => Object.entries(w).every(([k, c]) => cond(r[k], c));
  const sortBy = (rows, o) => { const l = Array.isArray(o) ? o : o ? [o] : []; return [...rows].sort((a, b) => { for (const x of l) { const [k, d] = Object.entries(x)[0]; const c = a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0; if (c) return d === "desc" ? -c : c; } return 0; }); };
  const model = (name) => new Proxy({
    findMany: async ({ where, orderBy, select } = {}) => { reads.add(name); return sortBy(t[name].filter((r) => match(r, where)), orderBy).map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r })); },
    findUnique: async ({ where }) => { reads.add(name); const r = t[name].find((x) => match(x, where)); return r ? { ...r } : null; },
    findFirst: async ({ where } = {}) => { reads.add(name); const r = t[name].find((x) => match(x, where)); return r ? { ...r } : null; },
  }, { get: (o, k) => { if (k in o) return o[k]; return () => { writes.push(`${name}.${String(k)}`); throw new Error(`TEST: write ${name}.${String(k)}`); }; } });
  const models = Object.fromEntries(Object.keys(t).map((k) => [k, model(k)]));
  models.setting = {
    findUnique: async ({ where }) => { if (!where.id.startsWith(PROFILE_META_PREFIX)) throw new Error(`TEST: forbidden setting ${where.id}`); reads.add("setting"); return meta ? { id: where.id, data: meta } : null; },
    findMany: async ({ where }) => {
      const ids = where?.id?.in;
      if (!Array.isArray(ids) || !ids.every((id) => id.startsWith("demo-sim-participants:"))) throw new Error("TEST: forbidden settings read");
      reads.add("setting");
      return ids.filter((id) => participants[id.slice(22)]).map((id) => ({ id, data: { ids: participants[id.slice(22)] } }));
    },
  };
  return new Proxy({ ...models, _writes: writes, _reads: reads }, { get: (o, k) => { if (k in o || typeof k === "symbol" || k === "then") return o[k]; throw new Error(`TEST: forbidden model ${String(k)}`); } });
}
{
  const hist = [row("h1", "2026-10-01", 4, 800), row("h2", "2026-10-02", 2, 400)].map((r) => ({ ...r, demoAffiliateId: "p1" }));
  hist.push({ ...row("other", "2026-10-01", 50, 9999), demoAffiliateId: "p2" }); // another profile: must be ignored
  const db = makeDb({ history: hist, coverage: [fullCov("2026-10-01")], participants: { "2026-10-01": ["p1"] } });
  demo.__setDemoDb(db);
  const args = { journeyId: "j1", demoAffiliateId: "p1", anchorDate: "2026-10-01", atDate: "2026-10-02", atTime: "15:00", locale: "fr" };
  const p = await svc.previewSchedule(args);
  ok("cycle 1 day 2, Casablanca, read-only flag", p.cycle.started && p.cycle.day === 2 && p.cycle.loopIndex === 0 && p.timezone === "Africa/Casablanca" && p.writes === "none" && p.atLocal.time === "15:00");
  ok("visible: day 1 + day 2 up to 15:00 (day 9 future excluded)", p.messages.map((m) => m.stepId).join(",") === "st1,st2,st3,st4");
  const ys = p.messages.find((m) => m.stepId === "st2"); const td = p.messages.find((m) => m.stepId === "st3");
  ok(`yesterday (day 1, row + coverage) → "${ys.text}"`, ys.state === "ok" && ys.text === "40,00 MAD hier" && ys.earnings.status === "complete");
  ok(`today (day 2 ≥ 12:00, row) → provisional "${td.text}"`, td.state === "provisional" && td.text === "20,00 MAD aujourd'hui (provisoire)");
  ok("image message carries its asset", p.messages.find((m) => m.stepId === "st4").asset?.url === "https://media.test/a1.webp");
  ok("deterministic: same request → identical JSON", JSON.stringify(await svc.previewSchedule(args)) === JSON.stringify(p));
  ok("no writes; reads limited to demo-chat / demo-profile tables", db._writes.length === 0 && [...db._reads].every((m) => ["demoChatJourney", "demoChatJourneyStep", "demoChatJourneyVersion", "demoChatAsset", "demoAffiliate", "demoEarningsHistory", "demoSimDayCoverage", "setting"].includes(m)));

  const late = await svc.previewSchedule({ ...args, atDate: "2026-10-09", atTime: "11:00" });
  const wk = late.messages.find((m) => m.stepId === "st5");
  ok("late view on day 9: earlier 'today' message now unavailable (send-time value not recorded)", late.messages.find((m) => m.stepId === "st3").state === "unavailable");
  ok("week without full history → 'données indisponibles', never 0", wk.state === "unavailable" && wk.text === EA.LABELS.fr.unavailable && wk.earnings.reason === "week_incomplete");
  const ar = await svc.previewSchedule({ ...args, locale: "ar" });
  ok("Darija labels on request", ar.messages.find((m) => m.stepId === "st2").text === "40,00 درهم البارح");
  const ver = await svc.previewSchedule({ ...args, versionId: "v1" });
  ok("published version uses its frozen snapshot", ver.source.kind === "version" && ver.messages.length === 1 && ver.messages[0].text === "Version 1");
  const before = await svc.previewSchedule({ ...args, atDate: "2026-09-30", atTime: "23:00" });
  ok("before day 1 → not started, no messages", !before.cycle.started && before.messages.length === 0);
  const rolled = await svc.previewSchedule({ ...args, atDate: "2026-10-31", atTime: "09:30" });
  ok("after rollover → cycle 2, previous cycle hidden", rolled.cycle.loopIndex === 1 && rolled.cycle.previousCyclesHidden === 1 && rolled.messages.every((m) => m.loopIndex === 1));
  ok("ISO `at` accepted", (await svc.previewSchedule({ journeyId: "j1", demoAffiliateId: "p1", anchorDate: "2026-10-01", at: "2026-10-02T14:00:00.000Z", locale: "fr" })).atLocal.time === "15:00");
  const errs = await Promise.all([
    rejects(() => svc.previewSchedule({ ...args, anchorDate: "2026-02-30" })),
    rejects(() => svc.previewSchedule({ ...args, atTime: "25:00" })),
    rejects(() => svc.previewSchedule({ journeyId: "j1", demoAffiliateId: "p1", anchorDate: "2026-10-01", at: "not-a-date" })),
    rejects(() => svc.previewSchedule({ ...args, locale: "en" })),
    rejects(() => svc.previewSchedule({ ...args, demoAffiliateId: "nope" })),
    rejects(() => svc.previewSchedule({ ...args, journeyId: "../x" })),
  ]);
  ok("invalid anchor / time / instant / locale → 400; unknown profile / journey → 404", errs.slice(0, 4).every((e) => e?.status === 400) && errs[4]?.status === 404 && errs[5]?.status === 404);
  const db2 = makeDb({ history: [], coverage: [] }); demo.__setDemoDb(db2);
  const noData = await svc.previewSchedule(args);
  ok("profile with no history and no coverage → every earnings message unavailable", noData.messages.filter((m) => m.type === "earnings").every((m) => m.state === "unavailable"));
  const db3 = makeDb({ history: [], coverage: [fullCov("2026-10-01")], participants: { "2026-10-01": ["p1"] } }); demo.__setDemoDb(db3);
  ok("no row + proven coverage + participation → 0,00 MAD (zero only when proven)", (await svc.previewSchedule(args)).messages.find((m) => m.stepId === "st2").text === "0,00 MAD hier");
  const db4 = makeDb({ history: [], coverage: [fullCov("2026-10-01")], participants: { "2026-10-01": ["other-profile"] } }); demo.__setDemoDb(db4);
  ok("no row + coverage but this profile did not take part → unavailable, never 0", (await svc.previewSchedule(args)).messages.find((m) => m.stepId === "st2").state === "unavailable");
}

// ── 6. Isolation & routes ─────────────────────────────────────────────────────
console.log("\n6. Isolation and routes");
{
  const files = ["src/lib/demoChatTime.js", "src/lib/demoChatSchedule.js", "src/lib/demoChatEarnings.js", "src/app/api/admin/demo-chat/preview/schedule/route.js"];
  const banned = /(order|commission|payout|withdraw|deposit|booster|balance|wallet|notification|whatsapp|sms|ugc|reward|fakeOrder|affiliateService|teamBonus|referral)/i;
  ok("new modules import no live order / money / messaging / UGC / rewards code", files.every((p) => [...src(p).matchAll(/from\s+['"]([^'"]+)['"]/g)].every((m) => !banned.test(m[1]))));
  ok("time / schedule / earnings modules are pure (no DB, no clock, no fs)", ["src/lib/demoChatTime.js", "src/lib/demoChatSchedule.js", "src/lib/demoChatEarnings.js"].every((p) => !/prisma|getDemoDb|Date\.now\(\)|node:fs/.test(src(p))));
  ok("no fixed 24 h arithmetic on local days (only on UTC buckets)", !/86_?400_?000/.test(src("src/lib/demoChatSchedule.js")) && /DAY_MS = 86_400_000; \/\/ UTC buckets/.test(src("src/lib/demoChatEarnings.js")));
  const route = src("src/app/api/admin/demo-chat/preview/schedule/route.js");
  ok("schedule preview route is withAdminAuth-wrapped", /export const POST = withAdminAuth\(/.test(route) && !/export (async )?function/.test(route));
  ok("process TZ never set", !/process\.env\.TZ\s*=/.test(["src/lib/demoChatTime.js", "src/lib/demoChatSchedule.js", "src/lib/demoChatEarnings.js", "src/lib/services/demoChatService.js"].map(src).join("\n")));
  ok("placeholders unchanged: {amount} {orders} {period}", JSON.stringify((await import("../src/lib/demoChatValidation.js")).PLACEHOLDERS) === JSON.stringify(["{amount}", "{orders}", "{period}"]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
