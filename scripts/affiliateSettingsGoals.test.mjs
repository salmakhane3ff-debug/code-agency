#!/usr/bin/env node
/**
 * scripts/affiliateSettingsGoals.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 0 (settings integrity) + Phase 1 (goals, dashboard visibility).
 * Proves, without a DB (injected fakes + source checks):
 *   • team-bonus-config POST validation (requiredActiveAffiliates ≥ 1 integer,
 *     ugcGoal ≥ 0 integer, securityDepositAmount > 0) with clear errors
 *   • the save MERGES: ugcGoal, securityDepositAmount and unknown keys survive
 *     a save that does not send them; one atomic statement, no read-modify-write
 *   • booster-packages / recruitment-landing use the merge path; team-bonus-config
 *     and affiliate-dashboard can no longer be written raw via /api/setting;
 *     the track counter is an atomic in-place increment
 *   • goals: 0 hides, > 0 unchanged, null/missing → existing default,
 *     negative/invalid safe on read and refused at the admin API
 *   • visibility toggles: defaults, validation, independent partial saves and
 *     the 4 deposit/booster combinations (tabs, mobile nav, overview card)
 *   • backend unchanged: booster/deposit APIs and the booster `enabled` gate do
 *     not read the visibility toggles; identity row is not goal-gated
 * Real-Postgres atomicity/concurrency: scripts/settingsMerge.harness.mjs.
 * Run: node scripts/affiliateSettingsGoals.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { validateTeamBonusConfigInput } from "../src/lib/teamBonusConfigValidation.js";
import { mergeSettings, incrementSettingsCounter, cleanSettingsPatch } from "../src/lib/settingsMerge.js";
import {
  saveTeamBonusConfig, getTeamBonusConfig, computeGamification, adminUpdateAffiliate, adminCreateAffiliate,
} from "../src/lib/services/affiliateSystemService.js";
import {
  normalizeAffiliateDashboardConfig, validateAffiliateDashboardPatch, hiddenDashboardTabs,
  AFFILIATE_DASHBOARD_SETTING_ID,
} from "../src/lib/affiliateDashboardConfig.js";
import {
  getAffiliateDashboardConfig, saveAffiliateDashboardConfig,
} from "../src/lib/services/affiliateDashboardConfigService.js";
import { resolveGoal, goalPercent, parseGoalInput, INVALID_GOAL } from "../src/lib/affiliateGoals.js";
import { upsertSettingsHandler } from "../src/lib/controllers/settingsController.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ── Fake db: emulates the two merge statements (each call is atomic in JS, as
// the single INSERT … ON CONFLICT statement is in Postgres). It deliberately has
// NO setting.upsert / update, so any whole-row write would throw.
function makeSettingsDb(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const sql = [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  return {
    rows, sql,
    setting: { findUnique: async ({ where }) => (rows.has(where.id) ? { id: where.id, data: structuredClone(rows.get(where.id)) } : null) },
    $queryRaw: async (strings, type, json) => {
      sql.push(strings.join("?"));
      const base = isObj(rows.get(type)) ? rows.get(type) : {};
      const merged = { ...base, ...JSON.parse(json) };
      rows.set(type, merged);
      return [{ data: structuredClone(merged) }];
    },
    $executeRaw: async (strings, type, group, key) => {
      sql.push(strings.join("?"));
      const base = isObj(rows.get(type)) ? rows.get(type) : {};
      const g = isObj(base[group]) ? base[group] : {};
      const cur = typeof g[key] === "number" ? g[key] : 0;
      rows.set(type, { ...base, [group]: { ...g, [key]: cur + 1 } });
      return 1;
    },
  };
}

const TIERS = [{ minDelivered: 0, maxDelivered: null, commissionPct: 5 }];
const base = { requiredActiveAffiliates: 10, bonusAmount: 2000, commissionTiers: TIERS };

// ── 1. Team-bonus validation ─────────────────────────────────────────────────
console.log("\n1. team-bonus-config validation");
{
  const v = validateTeamBonusConfigInput(base);
  ok("valid trio accepted", v.ok && v.patch.requiredActiveAffiliates === 10);
  ok("absent optional keys are not in the patch (kept by the merge)", v.ok && !("ugcGoal" in v.patch) && !("securityDepositAmount" in v.patch));
  ok("null optional keys are not in the patch", (() => { const r = validateTeamBonusConfigInput({ ...base, ugcGoal: null, securityDepositAmount: null }); return r.ok && !("ugcGoal" in r.patch) && !("securityDepositAmount" in r.patch); })());
  ok("unknown keys are never forwarded", (() => { const r = validateTeamBonusConfigInput({ ...base, evil: 1, teamBonusClaimed: true }); return r.ok && !("evil" in r.patch) && !("teamBonusClaimed" in r.patch); })());
  for (const [val, label] of [[0, "0"], [-1, "-1"], [1.5, "1.5"], ["10", "string"], [null, "null"], [undefined, "missing"]]) {
    const r = validateTeamBonusConfigInput({ ...base, requiredActiveAffiliates: val });
    ok(`requiredActiveAffiliates ${label} → 400 field requiredActiveAffiliates`, !r.ok && r.field === "requiredActiveAffiliates" && /entier/.test(r.error));
  }
  ok("requiredActiveAffiliates 1 accepted", validateTeamBonusConfigInput({ ...base, requiredActiveAffiliates: 1 }).ok);
  ok("ugcGoal 0 accepted (hidden)", (() => { const r = validateTeamBonusConfigInput({ ...base, ugcGoal: 0 }); return r.ok && r.patch.ugcGoal === 0; })());
  ok("ugcGoal 7 accepted", validateTeamBonusConfigInput({ ...base, ugcGoal: 7 }).patch?.ugcGoal === 7);
  for (const [val, label] of [[-1, "-1"], [2.5, "2.5"], ["3", "string"], [NaN, "NaN"]]) {
    const r = validateTeamBonusConfigInput({ ...base, ugcGoal: val });
    ok(`ugcGoal ${label} rejected with field ugcGoal`, !r.ok && r.field === "ugcGoal");
  }
  ok("securityDepositAmount 250 accepted", validateTeamBonusConfigInput({ ...base, securityDepositAmount: 250 }).patch?.securityDepositAmount === 250);
  ok("securityDepositAmount 99.5 accepted", validateTeamBonusConfigInput({ ...base, securityDepositAmount: 99.5 }).ok);
  for (const [val, label] of [[0, "0"], [-5, "-5"], ["500", "string"], [Infinity, "Infinity"]]) {
    const r = validateTeamBonusConfigInput({ ...base, securityDepositAmount: val });
    ok(`securityDepositAmount ${label} rejected with field securityDepositAmount`, !r.ok && r.field === "securityDepositAmount" && /positif/.test(r.error));
  }
  ok("bonusAmount rule unchanged (number required)", !validateTeamBonusConfigInput({ ...base, bonusAmount: "2000" }).ok && validateTeamBonusConfigInput({ ...base, bonusAmount: 0 }).ok);
  ok("commissionTiers rule unchanged (non-empty array)", !validateTeamBonusConfigInput({ ...base, commissionTiers: [] }).ok);
  ok("non-object body → Données invalides", ["x", null, [], 5].every((b) => !validateTeamBonusConfigInput(b).ok));
}

// ── 2. Team-bonus save merges ────────────────────────────────────────────────
console.log("\n2. team-bonus-config save preserves unrelated keys");
{
  const db = makeSettingsDb({ "team-bonus-config": { ...base, ugcGoal: 3, securityDepositAmount: 750, legacyKey: "keep" } });
  const saved = await saveTeamBonusConfig({ requiredActiveAffiliates: 12, bonusAmount: 2500, commissionTiers: TIERS }, { db });
  ok("sent keys updated", saved.requiredActiveAffiliates === 12 && saved.bonusAmount === 2500);
  ok("ugcGoal preserved", saved.ugcGoal === 3);
  ok("securityDepositAmount preserved", saved.securityDepositAmount === 750);
  ok("unknown key preserved", saved.legacyKey === "keep");
  ok("one atomic INSERT … ON CONFLICT … || statement (no read-modify-write)",
    db.sql.length === 1 && /ON CONFLICT/.test(db.sql[0]) && /\|\| EXCLUDED\."data"/.test(db.sql[0]));
  await saveTeamBonusConfig({ ...base, ugcGoal: 0 }, { db });
  ok("ugcGoal 0 stored as 0", db.rows.get("team-bonus-config").ugcGoal === 0);
  const cfg = await getTeamBonusConfig({ db });
  ok("getTeamBonusConfig keeps ugcGoal 0 (hidden), not the default 5", cfg.ugcGoal === 0);
  ok("deposit amount still read", cfg.securityDepositAmount === 750);
  const d2 = makeSettingsDb({ "team-bonus-config": { ...base } });
  ok("missing ugcGoal → default 5", (await getTeamBonusConfig({ db: d2 })).ugcGoal === 5);
  const d3 = makeSettingsDb({ "team-bonus-config": { ...base, ugcGoal: -4 } });
  ok("legacy negative ugcGoal → default 5 (safe read)", (await getTeamBonusConfig({ db: d3 })).ugcGoal === 5);
  const d4 = makeSettingsDb({ "team-bonus-config": { ...base, ugcGoal: "abc" } });
  ok("invalid ugcGoal → default 5", (await getTeamBonusConfig({ db: d4 })).ugcGoal === 5);
  const d5 = makeSettingsDb({ "team-bonus-config": { ...base, ugcGoal: 6 } });
  ok("positive ugcGoal unchanged", (await getTeamBonusConfig({ db: d5 })).ugcGoal === 6);

  const fresh = makeSettingsDb();
  ok("missing row → created by the merge", (await saveTeamBonusConfig(base, { db: fresh })).requiredActiveAffiliates === 10);

  // Concurrency (fake): parallel partial saves never drop each other's keys.
  const cdb = makeSettingsDb({ "team-bonus-config": { ...base } });
  await Promise.all([
    mergeSettings("team-bonus-config", { ugcGoal: 4 }, { db: cdb }),
    mergeSettings("team-bonus-config", { securityDepositAmount: 600 }, { db: cdb }),
    saveTeamBonusConfig({ ...base, bonusAmount: 3000 }, { db: cdb }),
  ]);
  const row = cdb.rows.get("team-bonus-config");
  ok("concurrent partial saves all kept", row.ugcGoal === 4 && row.securityDepositAmount === 600 && row.bonusAmount === 3000);
}

// ── 3. Merge helper + generic /api/setting paths ─────────────────────────────
console.log("\n3. Merge helper, generic settings route, track counter");
{
  ok("meta keys stripped from patch", JSON.stringify(cleanSettingsPatch({ _id: 1, id: 2, createdAt: 3, updatedAt: 4, a: 1, u: undefined })) === '{"a":1}');
  ok("non-object patch → {}", JSON.stringify(cleanSettingsPatch([1])) === "{}" && JSON.stringify(cleanSettingsPatch(null)) === "{}");

  const db = makeSettingsDb({ "booster-packages": { enabled: true, allowStacking: false, packages: [{ id: "p1" }], simulation: { enabled: true }, extra: 1 } });
  const out = await mergeSettings("booster-packages", { packages: [{ id: "p2" }] }, { db });
  ok("booster partial update keeps enabled/simulation/extra", out.enabled === true && out.simulation.enabled === true && out.extra === 1);
  ok("booster sent key replaced as a whole", out.packages.length === 1 && out.packages[0].id === "p2");

  const rdb = makeSettingsDb({ "recruitment-landing": { enabled: true, hero: { title: "T" }, stats: { login: 5 } } });
  await incrementSettingsCounter("recruitment-landing", "stats", "login", { db: rdb });
  await incrementSettingsCounter("recruitment-landing", "stats", "view", { db: rdb });
  const r = rdb.rows.get("recruitment-landing");
  ok("counter +1 keeps the other counters and the config", r.stats.login === 6 && r.stats.view === 1 && r.hero.title === "T" && r.enabled === true);
  await mergeSettings("recruitment-landing", { hero: { title: "New" } }, { db: rdb });
  ok("admin save (without stats) keeps the live counters", rdb.rows.get("recruitment-landing").stats.login === 6);

  const ctrl = src("src/lib/controllers/settingsController.js");
  ok("booster-packages + recruitment-landing routed to mergeSettings",
    /MERGE_SETTING_TYPES = new Set\(\['booster-packages', 'recruitment-landing'\]\)/.test(ctrl) && /MERGE_SETTING_TYPES\.has\(type\)\s*\?\s*await mergeSettings/.test(ctrl));
  ok("other generic types keep the existing upsert", /: await upsertSettings\(type, body\)/.test(ctrl));

  for (const type of ["team-bonus-config", AFFILIATE_DASHBOARD_SETTING_ID, "rewards-config"]) {
    const res = await upsertSettingsHandler(new Request(`http://x/api/setting?type=${type}`, { method: "POST", body: JSON.stringify({ requiredActiveAffiliates: -1 }) }));
    ok(`generic POST ${type} refused (400, validation cannot be bypassed)`, res.status === 400);
  }

  const track = src("src/app/api/tsajlim3ana/track/route.js");
  ok("track route: atomic counter, no read-modify-write of the landing row",
    /incrementSettingsCounter\("recruitment-landing", "stats", event\)/.test(track) && !/upsertSettings|getSettings/.test(track));
  const admin = src("src/app/admin/affiliates/page.jsx");
  ok("admin recruitment save no longer sends a stale stats copy", !/\{ stats: cfg\.stats \}/.test(admin));
  ok("admin team-bonus save sends ugcGoal + securityDepositAmount", /ugcGoal: Number\(cfg\.ugcGoal\)/.test(admin) && /securityDepositAmount: Number\(cfg\.securityDepositAmount\)/.test(admin));
}

// ── 4. Authorization ─────────────────────────────────────────────────────────
console.log("\n4. Authorization");
{
  const vis = src("src/app/api/admin/affiliate-dashboard-config/route.js");
  ok("visibility route GET + POST wrapped in withAdminAuth",
    /export const GET = withAdminAuth\(/.test(vis) && /export const POST = withAdminAuth\(/.test(vis) && !/export (async )?function/.test(vis));
  const tb = src("src/app/api/admin/team-bonus-config/route.js");
  ok("team-bonus route still admin-only", /export const GET = withAdminAuth\(/.test(tb) && /export const POST = withAdminAuth\(/.test(tb));
  const setting = src("src/app/api/setting/route.js");
  const pub = setting.slice(setting.indexOf("const PUBLIC_TYPES"), setting.indexOf("]);"));
  ok("protected rows are not public reads", ["team-bonus-config", "affiliate-dashboard", "booster-packages", "recruitment-landing"].every((t) => !pub.includes(`'${t}'`)));
  ok("/api/setting POST still admin-only", /export const POST = withAdminAuth\(upsertSettingsHandler\)/.test(setting));
  const me = src("src/app/api/affiliate/me/route.js");
  ok("/me (affiliate-auth) returns only the normalized visibility flags", /export const GET = withAffiliateAuth\(getHandler\)/.test(me) && /getAffiliateDashboardConfig\(\)/.test(me));
}

// ── 5. Goals ─────────────────────────────────────────────────────────────────
console.log("\n5. Goals (0 hides, >0 unchanged, null → default, invalid safe)");
{
  ok("resolveGoal 0 → hidden", resolveGoal(0, 5).hidden === true);
  ok("resolveGoal '0' → hidden", resolveGoal("0", 5).hidden === true);
  ok("resolveGoal 1 → target 1", !resolveGoal(1, 5).hidden && resolveGoal(1, 5).target === 1);
  ok("resolveGoal 12 → target 12", resolveGoal(12, 5).target === 12);
  ok("resolveGoal null/undefined → default", resolveGoal(null, 5).target === 5 && resolveGoal(undefined, 5).target === 5 && !resolveGoal(null, 5).hidden);
  ok("resolveGoal negative → default (not hidden)", resolveGoal(-3, 5).target === 5 && !resolveGoal(-3, 5).hidden);
  ok("resolveGoal invalid → default", [NaN, "abc", 2.5, {}, ""].every((v) => resolveGoal(v, 5).target === 5 && !resolveGoal(v, 5).hidden));
  ok("goalPercent never divides by 0", goalPercent(3, 0) === 0 && goalPercent(3, null) === 0 && goalPercent(3, -1) === 0);
  ok("goalPercent clamps 0–100", goalPercent(10, 5) === 100 && goalPercent(1, 4) === 25 && goalPercent(-2, 4) === 0);

  const g0 = computeGamification(2, 4, 0);
  ok("gamification goal 0 → hidden, no target/progress", g0.hidden === true && g0.target === 0 && g0.progress === 0 && g0.remaining === 0 && g0.validReferrals === 2);
  const g1 = computeGamification(0, 0, 1);
  ok("gamification goal 1 unchanged", !g1.hidden && g1.target === 1 && g1.progress === 0 && g1.remaining === 1);
  const g8 = computeGamification(4, 0, 8);
  ok("gamification goal 8 unchanged", g8.target === 8 && g8.progress === 50 && g8.remaining === 4);
  ok("gamification null → existing computed default", computeGamification(1, 4, null).target === 3 && computeGamification(1, 0, null).target === 5);
  ok("gamification negative/invalid → computed default", computeGamification(1, 0, -2).target === 5 && computeGamification(1, 0, 2.5).target === 5 && !computeGamification(1, 0, -2).hidden);

  ok("parseGoalInput '' / null / 'abc' → null (default, as before)", parseGoalInput("", "x") === null && parseGoalInput(null, "x") === null && parseGoalInput("abc", "x") === null);
  ok("parseGoalInput 0 → 0", parseGoalInput("0", "x") === 0 && Object.is(parseGoalInput("-0", "x"), 0));
  ok("parseGoalInput 7 → 7", parseGoalInput(7, "x") === 7);
  const e = (() => { try { parseGoalInput("-1", "Objectif commandes"); } catch (err) { return err; } return null; })();
  ok("parseGoalInput negative → INVALID_GOAL with a clear message", e?.code === INVALID_GOAL && /Objectif commandes/.test(e.message) && /négative/.test(e.message));

  // adminUpdateAffiliate through a fake db: negative → nothing written.
  const updates = [];
  const adb = { affiliate: {
    update: async ({ where, data }) => { updates.push(data); return { id: where.id, username: "a", name: "A", ...data }; },
    findUnique: async () => ({ isActive: true }),
  } };
  const err = await rejects(adminUpdateAffiliate("a1", { goalOrders: -2 }, { db: adb }));
  ok("adminUpdateAffiliate negative goalOrders → INVALID_GOAL, no write", err?.code === INVALID_GOAL && updates.length === 0);
  const err2 = await rejects(adminUpdateAffiliate("a1", { goalValidReferrals: "-1" }, { db: adb }));
  ok("adminUpdateAffiliate negative goalValidReferrals → INVALID_GOAL, no write", err2?.code === INVALID_GOAL && updates.length === 0);
  await adminUpdateAffiliate("a1", { goalOrders: "0", goalValidReferrals: 0 }, { db: adb });
  ok("adminUpdateAffiliate 0 stored (hidden)", updates[0].goalOrders === 0 && updates[0].goalValidReferrals === 0);
  await adminUpdateAffiliate("a1", { goalOrders: "", goalValidReferrals: 6 }, { db: adb });
  ok("adminUpdateAffiliate '' → null, 6 → 6 (unchanged rules)", updates[1].goalOrders === null && updates[1].goalValidReferrals === 6);
  await adminUpdateAffiliate("a1", { isActive: false }, { db: adb });
  ok("quick toggle without goal keys never touches goals", !("goalOrders" in updates[2]) && !("goalValidReferrals" in updates[2]));
  const cerr = await rejects(adminCreateAffiliate({ username: "neg", password: "pw", goalOrders: "-3" }));
  ok("adminCreateAffiliate negative goal → INVALID_GOAL before any DB write", cerr?.code === INVALID_GOAL);
  const route = src("src/app/api/admin/affiliates/route.js");
  ok("admin affiliates POST + PUT map INVALID_GOAL → 400", (route.match(/code === INVALID_GOAL\) \{\s*return Response\.json\(\{ error: err\.message \}, \{ status: 400 \}\)/g) || []).length === 2);
}

// ── 6. Visibility toggles ────────────────────────────────────────────────────
console.log("\n6. Dashboard visibility toggles");
{
  ok("defaults: both visible (no row)", JSON.stringify(normalizeAffiliateDashboardConfig(undefined)) === '{"depositBarEnabled":true,"boosterBarEnabled":true}');
  ok("only explicit false hides", normalizeAffiliateDashboardConfig({ depositBarEnabled: "false", boosterBarEnabled: 0 }).depositBarEnabled === true
    && normalizeAffiliateDashboardConfig({ boosterBarEnabled: 0 }).boosterBarEnabled === true);
  ok("unknown keys never exposed", Object.keys(normalizeAffiliateDashboardConfig({ depositBarEnabled: false, secret: "x" })).join() === "depositBarEnabled,boosterBarEnabled");
  ok("patch: single toggle accepted", JSON.stringify(validateAffiliateDashboardPatch({ boosterBarEnabled: false }).patch) === '{"boosterBarEnabled":false}');
  ok("patch: non-boolean rejected", !validateAffiliateDashboardPatch({ depositBarEnabled: "no" }).ok);
  ok("patch: empty / unknown-only rejected", !validateAffiliateDashboardPatch({}).ok && !validateAffiliateDashboardPatch({ x: true }).ok && !validateAffiliateDashboardPatch(null).ok);
  ok("patch: unknown keys dropped", !("x" in validateAffiliateDashboardPatch({ depositBarEnabled: true, x: 1 }).patch));

  const db = makeSettingsDb();
  ok("service default read (no row)", (await getAffiliateDashboardConfig({ db })).boosterBarEnabled === true);
  await saveAffiliateDashboardConfig({ depositBarEnabled: false }, { db });
  await saveAffiliateDashboardConfig({ boosterBarEnabled: false }, { db });
  let c = await getAffiliateDashboardConfig({ db });
  ok("independent saves: second toggle does not reset the first", c.depositBarEnabled === false && c.boosterBarEnabled === false);
  await saveAffiliateDashboardConfig({ depositBarEnabled: true }, { db });
  c = await getAffiliateDashboardConfig({ db });
  ok("re-enabling one keeps the other hidden", c.depositBarEnabled === true && c.boosterBarEnabled === false);
  ok("persisted under the affiliate-dashboard row", db.rows.has("affiliate-dashboard"));

  const combos = [
    [{ depositBarEnabled: true,  boosterBarEnabled: true  }, []],
    [{ depositBarEnabled: false, boosterBarEnabled: true  }, ["deposit"]],
    [{ depositBarEnabled: true,  boosterBarEnabled: false }, ["booster"]],
    [{ depositBarEnabled: false, boosterBarEnabled: false }, ["deposit", "booster"]],
  ];
  for (const [cfg, hidden] of combos) {
    ok(`combo deposit=${cfg.depositBarEnabled} booster=${cfg.boosterBarEnabled} → hidden [${hidden}]`, JSON.stringify(hiddenDashboardTabs(cfg)) === JSON.stringify(hidden));
  }

  const dash = src("src/app/affiliate/dashboard/page.jsx");
  ok("tabs list filtered by hiddenTabs", /\]\.filter\(\(t\) => !hiddenTabs\.includes\(t\.id\)\);/.test(dash));
  ok("mobile nav entries filtered by hiddenTabs", /\]\.filter\(\(item\) => !hiddenTabs\.includes\(item\.tab\)\);/.test(dash) && /hiddenTabs=\{hiddenTabs\}/.test(dash));
  ok("overview deposit card gated", /\{depositVisible && \(\s*<button onClick=\{goToDeposit\}/.test(dash));
  ok("overview booster widget gated", /\{boosterVisible && activeBoosters\.map/.test(dash));
  ok("tab renders gated", /activeTab === "deposit" && depositVisible &&/.test(dash) && /activeTab === "booster" && boosterVisible &&/.test(dash));
  ok("hidden open tab falls back to overview", /hiddenDashboardTabs\(data\?\.dashboard\)\.includes\(activeTab\)\) setActiveTab\("overview"\)/.test(dash));
  ok("booster recharge shortcut hidden with the deposit bar", /onRecharge=\{depositVisible \? goToDeposit : undefined\}/.test(dash));

  // Backend unchanged: no API / eligibility path reads the visibility toggles.
  for (const f of ["src/lib/services/boosterService.js", "src/lib/services/depositService.js",
                   "src/app/api/affiliate/boosters/route.js", "src/app/api/affiliate/deposits/route.js"]) {
    let t = ""; try { t = src(f); } catch { t = ""; }
    ok(`${f} does not read the visibility toggles`, t !== "" && !/affiliate-dashboard|depositBarEnabled|boosterBarEnabled|affiliateDashboardConfig/.test(t));
  }
  const boosterSrc = src("src/lib/services/boosterService.js");
  ok("booster `enabled` purchase gate preserved", /enabled:\s+c\.enabled === true/.test(boosterSrc) && /if \(!config\.enabled\) throw err\('BOOSTERS_DISABLED'/.test(boosterSrc));

  // Identity verification row is not tied to any goal / toggle.
  const idIdx = dash.indexOf("onClick={goToIdentity}\n");
  const ugcEnd = dash.lastIndexOf(")}", idIdx);
  const between = dash.slice(ugcEnd, idIdx);
  ok("identity row rendered unconditionally after the goal rows", idIdx > 0 && !/hidden|Visible|&&/.test(between.replace(/\)\}/, "")));
  ok("identity status logic unchanged", /const identityStatus\s+= identity\?\.status \|\| "NOT_SUBMITTED";/.test(dash));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
