#!/usr/bin/env node
/**
 * scripts/liveText.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Display-time localization of the server-written LIVE texts
 * (src/lib/serverText/liveText.js), proven against the REAL server code:
 *   • buildEvent()            src/lib/services/liveActivityEngine.js
 *   • relTime(), formatLiveFeedEvent(), maskFirstName()   src/lib/recruitmentCta.js
 *   • MOROCCAN_CITIES         src/lib/recruitmentLiveData.js
 * For every template/type: generate the server output → localize →
 *   'ar' (MA) = byte-identical to the server output, 'fr' (FR) = expected French.
 * Unrecognised text (names, admin-configured cities, free text) stays unchanged.
 * The engine's inline literals are also pinned here AND statically checked in the
 * engine source, so any wording drift on the server breaks this test.
 * Pure — no DOM / network / DB.
 * Run: node scripts/liveText.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { buildEvent } from "../src/lib/services/liveActivityEngine.js";
import {
  relTime, formatLiveFeedEvent, maskFirstName, normalizeLiveActivity, LIVE_FEED_EVENT_TYPES, LIVE_FEED_NEUTRAL,
} from "../src/lib/recruitmentCta.js";
import { MOROCCAN_CITIES } from "../src/lib/recruitmentLiveData.js";
import {
  LIVE_ACTIVITY_TEXT_FR, LIVE_DEFAULT_NAME, CITY_FR, LIVE_FEED_TEMPLATES,
  localizeLiveActivityText, localizeBoosterDetail, localizeLiveName, localizeRelTime, localizeCity,
  localizeLiveActivityEvent, parseLiveFeedText, localizeLiveFeedText,
} from "../src/lib/serverText/liveText.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const LANGS = ["ar", "fr"];
const ENGINE_SRC = readFileSync("src/lib/services/liveActivityEngine.js", "utf8");
const MODULE_SRC = readFileSync("src/lib/serverText/liveText.js", "utf8");

// Pinned server literals (liveActivityEngine.buildEvent) → expected French display.
const PINNED_ACTIVITY = {
  delivered:        { ar: "تم تسليم طلب", fr: "Commande livrée" },
  commission:       { ar: "عمولة جديدة", fr: "Nouvelle commission" },
  newOrder:         { ar: "طلب جديد", fr: "Nouvelle commande" },
  newAffiliate:     { ar: "انضمت للمنصة", fr: "A rejoint la plateforme" },
  boosterMilestone: { ar: "وصلت", fr: "A atteint" },
  boosterSales:     { ar: "Starter Booster", fr: "Starter Booster" },
  competition:      { ar: "دخلات المنافسة ديال هاد الشهر", fr: "A rejoint la compétition du mois" },
};

console.log("1) Engine source still writes the pinned literals (drift guard):");
{
  for (const [k, v] of Object.entries(PINNED_ACTIVITY)) {
    ok(`engine contains activity '${v.ar}' (${k})`, ENGINE_SRC.includes(`activity: '${v.ar}'`));
  }
  ok("engine default name is 'مسوقة'", ENGINE_SRC.includes("name:      person?.name || 'مسوقة',") && LIVE_DEFAULT_NAME === "مسوقة");
  ok("engine booster sales detail template", ENGINE_SRC.includes("detail: `+${n} ${n === 1 ? 'مبيعة' : 'مبيعات'}`"));
  ok("engine booster milestone detail template (digits only)", ENGINE_SRC.includes("detail: `${fact.sales} / ${fact.target}`"));
  ok("engine serves time from relTime()", ENGINE_SRC.includes("const time = relTime(now - (e.at || now));"));
  const literals = [...ENGINE_SRC.matchAll(/activity: '([^']+)'/g)].map((m) => m[1]);
  ok(`every engine activity literal (${literals.length}) is localized`, literals.length === 7 && literals.every((l) => l in LIVE_ACTIVITY_TEXT_FR));
  ok("dictionary covers exactly the engine literals", Object.keys(LIVE_ACTIVITY_TEXT_FR).sort().join("|") === [...literals].sort().join("|"));
}

console.log("2) buildEvent() × every type × both languages (real server function):");
{
  const pool = [{ id: "demo_1", name: "Karima Alaoui", username: "karima1", avatarUrl: null, avatarColor: "#6366f1" }];
  const now = Date.now();
  const r0 = () => 0;
  const base = normalizeLiveActivity({});
  const cases = [
    ["delivered", {}, PINNED_ACTIVITY.delivered],
    ["commission", {}, PINNED_ACTIVITY.commission],
    ["newOrder", {}, PINNED_ACTIVITY.newOrder],
    ["newAffiliate", {}, PINNED_ACTIVITY.newAffiliate],
    ["competition", {}, PINNED_ACTIVITY.competition],
    ["booster", { boosterFacts: [{ kind: "milestone", sales: 12, target: 20 }] }, PINNED_ACTIVITY.boosterMilestone],
    ["booster", { boosterFacts: [{ kind: "sales", count: 1 }] }, PINNED_ACTIVITY.boosterSales],
    ["booster", { boosterFacts: [{ kind: "sales", count: 4 }] }, PINNED_ACTIVITY.boosterSales],
  ];
  for (const [type, extra, exp] of cases) {
    for (const withPerson of [true, false]) {
      const cfg = { ...base, ...extra, cities: ["فاس"] };
      const ev = buildEvent(type, cfg, now, withPerson ? pool : [], r0);
      ev.time = relTime(42_000); // as served
      const label = `${type}${extra.boosterFacts ? `/${extra.boosterFacts[0].kind}${extra.boosterFacts[0].count ?? ""}` : ""}${withPerson ? "" : " (no person)"}`;
      const ar = localizeLiveActivityEvent(ev, "ar");
      ok(`${label}: ar identical to server output`, ar === ev && JSON.stringify(ar) === JSON.stringify(ev));
      const fr = localizeLiveActivityEvent(ev, "fr");
      ok(`${label}: server activity is the pinned literal`, ev.activity === exp.ar);
      ok(`${label}: fr activity`, fr.activity === exp.fr);
      ok(`${label}: fr time`, fr.time === "il y a 42 s");
      ok(`${label}: fr name (person kept / default → Affiliée)`, fr.name === (withPerson ? "Karima Alaoui" : "Affiliée"));
      if ("city" in ev) ok(`${label}: fr city`, fr.city === "Fès");
      if (type === "booster" && extra.boosterFacts[0].kind === "milestone") ok(`${label}: "a / b" detail unchanged`, ev.detail === "12 / 20" && fr.detail === "12 / 20");
      if (type === "booster" && extra.boosterFacts[0].kind === "sales") {
        const n = extra.boosterFacts[0].count;
        ok(`${label}: fr detail "+${n} vente(s)"`, fr.detail === (n === 1 ? "+1 vente" : `+${n} ventes`) && ev.detail !== fr.detail);
      }
      ok(`${label}: data fields untouched`, ["id", "type", "at", "amount", "personId", "username", "avatarUrl", "color", "icon", "boosterSales"].every((k) => fr[k] === ev[k]));
      ok(`${label}: server event not mutated`, ev.activity === exp.ar);
    }
  }
  // UGC: no server sentence (client-rendered labels); localizer leaves its data alone.
  const ugc = { ...buildEvent("ugc", base, now, pool, r0), time: relTime(5 * 60_000), earnings: 40 };
  const ugcFr = localizeLiveActivityEvent(ugc, "fr");
  ok("ugc: ar identical", localizeLiveActivityEvent(ugc, "ar") === ugc);
  ok("ugc: fr keeps videos/sales/earnings, localizes time only", ugcFr.videos === ugc.videos && ugcFr.sales === ugc.sales && ugcFr.earnings === 40 && ugcFr.time === "il y a 5 min" && !("city" in ugcFr));
  ok("booster without simulation facts → null passes through", buildEvent("booster", base, now, pool, r0) === null && localizeLiveActivityEvent(null, "fr") === null);
  ok("a real person literally named 'مسوقة' keeps the name", localizeLiveName("مسوقة", "demo_9", "fr") === "مسوقة");
}

console.log("3) relTime() round-trip (every unit, boundaries):");
{
  const ages = [0, 400, 1000, 1499, 1500, 15_000, 59_000, 59_499, 59_500, 60_000, 89_000, 90_000, 30 * 60_000,
    59 * 60_000, 3_569_000, 3_570_000, 3_600_000, 2 * 3_600_000, 25 * 3_600_000, 10 * 86_400_000];
  let allAr = true, allFr = true;
  for (const age of ages) {
    const server = relTime(age);
    // Independent expectation of relTime's semantics.
    const s = Math.max(1, Math.round(age / 1000));
    const m = Math.round(s / 60);
    const exp = s < 60 ? `il y a ${s} s` : m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`;
    if (localizeRelTime(server, "ar") !== server) allAr = false;
    if (localizeRelTime(server, "fr") !== exp) { allFr = false; console.log("     mismatch", age, server, localizeRelTime(server, "fr"), exp); }
  }
  ok(`ar identical for ${ages.length} ages`, allAr);
  ok(`fr "il y a N s|min|h" for ${ages.length} ages`, allFr);
  ok("exact samples", localizeRelTime("قبل 15 ث", "fr") === "il y a 15 s" && localizeRelTime("قبل 1 د", "fr") === "il y a 1 min" && localizeRelTime("قبل 2 س", "fr") === "il y a 2 h");
  ok("non-template time unchanged", ["الآن", "قبل 5 أيام", "5 min", "قبل 5 ث ", ""].every((x) => localizeRelTime(x, "fr") === x));
}

console.log("4) Cities: every MOROCCAN_CITIES entry mapped to French:");
{
  const missing = MOROCCAN_CITIES.filter((c) => !(c in CITY_FR));
  if (missing.length) console.log("     missing:", missing);
  ok(`all ${MOROCCAN_CITIES.length} cities have a French spelling`, missing.length === 0 && MOROCCAN_CITIES.length >= 150);
  ok("French spellings are Latin, non-empty", Object.values(CITY_FR).every((v) => typeof v === "string" && v.trim() && !/[؀-ۿ]/.test(v)));
  const extra = Object.keys(CITY_FR).filter((k) => !MOROCCAN_CITIES.includes(k));
  ok("map holds no city outside the dataset", extra.length === 0);
  ok("ar: every city unchanged", MOROCCAN_CITIES.every((c) => localizeCity(c, "ar") === c));
  ok("fr: every city localized", MOROCCAN_CITIES.every((c) => localizeCity(c, "fr") === CITY_FR[c]));
  ok("well-known spellings", [["الدار البيضاء", "Casablanca"], ["الرباط", "Rabat"], ["مراكش", "Marrakech"], ["فاس", "Fès"], ["طنجة", "Tanger"], ["أكادير", "Agadir"], ["مكناس", "Meknès"], ["وجدة", "Oujda"], ["القنيطرة", "Kénitra"], ["تطوان", "Tétouan"], ["سلا", "Salé"], ["العيون", "Laâyoune"]].every(([a, f]) => CITY_FR[a] === f));
  ok("admin-configured unknown city unchanged", localizeCity("قرية جديدة", "fr") === "قرية جديدة" && localizeCity("Lyon", "fr") === "Lyon");
  // Through the real engine with an admin city list.
  const cfg = normalizeLiveActivity({ cities: ["قرية جديدة"] });
  const ev = buildEvent("newOrder", cfg, Date.now(), [], () => 0);
  ok("engine event with admin city: fr city unchanged", localizeLiveActivityEvent(ev, "fr").city === "قرية جديدة");
}

console.log("5) formatLiveFeedEvent() × every type × both languages:");
{
  const FR = {
    new_affiliate:   (n) => `${n} a récemment rejoint la plateforme`,
    first_order:     (n) => `${n} a confirmé sa première commande`,
    order_milestone: (n, c) => `${n} a confirmé ${c} ${c < 2 ? "commande" : "commandes"} aujourd'hui`,
    team_milestone:  (n, c) => `L'équipe de ${n} a atteint ${c} ${c < 2 ? "membre" : "membres"}`,
    ugc_uploaded:    (n) => `${n} a publié sa vidéo UGC`,
    ugc_approved:    (n) => `La vidéo UGC de ${n} a été validée`,
    rank_change:     (n, _c, r) => `${n} est à la ${r === 1 ? "1re" : `${r}e`} place de la compétition`,
    badge_unlocked:  (n) => `${n} a obtenu un nouveau badge`,
  };
  ok("every server live-feed type has a template", LIVE_FEED_EVENT_TYPES.every((t) => LIVE_FEED_TEMPLATES[t]) && Object.keys(LIVE_FEED_TEMPLATES).length === LIVE_FEED_EVENT_TYPES.length);
  const names = ["Sara Alaoui", "فاطمة الزهراء", "Nour", "O'Brien-Lee X", ""];
  const counts = [0, 1, 2, 5, 12, 150];
  for (const type of LIVE_FEED_EVENT_TYPES) {
    let arOk = true, frOk = true, frNoTypeOk = true, parseOk = true, n = 0;
    for (const name of names) for (const c of counts) {
      const raw = { type, name, count: c, rank: c || 1 };
      const server = formatLiveFeedEvent(raw);
      const masked = maskFirstName(name);
      const exp = FR[type](masked, c, raw.rank);
      n++;
      if (localizeLiveFeedText(server, type, "ar") !== server) arOk = false;
      if (localizeLiveFeedText(server, type, "fr") !== exp) { frOk = false; console.log("     fr mismatch", type, JSON.stringify(server), localizeLiveFeedText(server, type, "fr"), exp); }
      if (localizeLiveFeedText(server, undefined, "fr") !== exp) frNoTypeOk = false;
      const p = parseLiveFeedText(server, type);
      if (!p || p.type !== type || p.name !== masked) parseOk = false;
    }
    ok(`${type}: ar identical to server (${n} cases)`, arOk);
    ok(`${type}: fr rendering`, frOk);
    ok(`${type}: fr rendering without the type hint`, frNoTypeOk);
    ok(`${type}: parsed back to the masked first name`, parseOk);
  }
  ok("unknown type → server returns '' → unchanged", formatLiveFeedEvent({ type: "x", name: "A" }) === "" && localizeLiveFeedText("", "x", "fr") === "");
  ok("neutral messages are not touched here (client dictionary handles them)", LIVE_FEED_NEUTRAL.every((m) => localizeLiveFeedText(m, "neutral", "fr") === m));
}

console.log("6) Unknown / non-template text is returned unchanged:");
{
  const junk = ["", "  ", "نص حر كتبو الأدمين", "Free admin text", "تم تسليم طلب!", "طلب جديد ", "+3 مبيعات اليوم", "12 / 20", "قبل ث", null, undefined, 42];
  for (const lang of LANGS) {
    ok(`${lang}: activity`, junk.every((x) => localizeLiveActivityText(x, lang) === x));
    ok(`${lang}: booster detail`, junk.every((x) => localizeBoosterDetail(x, lang) === x));
    ok(`${lang}: relative time`, junk.every((x) => localizeRelTime(x, lang) === x));
    ok(`${lang}: city`, junk.every((x) => localizeCity(x, lang) === x));
    ok(`${lang}: live-feed sentence`, junk.every((x) => localizeLiveFeedText(x, "new_affiliate", lang) === x));
  }
  ok("unknown lang behaves like Arabic (unchanged)", localizeRelTime("قبل 3 د", "en") === "قبل 3 د" && localizeLiveActivityText("طلب جديد", undefined) === "طلب جديد");
  ok("real person names never translated", localizeLiveActivityEvent({ name: "سارة", personId: "demo_2" }, "fr").name === "سارة");
}

console.log("7) Module is pure and wired into the UI:");
{
  ok("no React / DOM / I/O in liveText.js", !/from ['"]react['"]|\bwindow\.|\bdocument\.|\bfetch\(|require\(|from ['"]node:/.test(MODULE_SRC));
  const la = readFileSync("src/components/LiveActivity.jsx", "utf8");
  ok("LiveActivity localizes every served event with the market lang", la.includes('import { localizeLiveActivityEvent } from "@/lib/serverText/liveText"')
    && la.includes(".map((ev) => localizeLiveActivityEvent(ev, lang))") && la.includes("const { t, dir, lang } = useMarketLocale(LIVE_TEXT);"));
  ok("LiveActivity commissions counter currency follows the market (درهم / DH)", la.includes('currency_suffix: " درهم"') && la.includes('currency_suffix: " DH"')
    && la.includes('suffix={m.currency ? t("currency_suffix") : ""}') && !/\bsuffix: " DH"/.test(la));
  ok("LiveActivity still polls the single server engine", la.includes('fetch("/api/live-activity", { cache: "no-store" })'));
  const rl = readFileSync("src/app/tsajlim3ana/RecruitmentLanding.jsx", "utf8");
  ok("recruitment live feed localizes the server sentence", rl.includes("localizeLiveFeedText(current.text, current.type, lang)"));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
