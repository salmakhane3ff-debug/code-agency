#!/usr/bin/env node
/**
 * scripts/demoCompetitionAdmin.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Competition — ADMIN UI (SIMULATION ONLY). Static checks of the section
 * inside the existing admin panel + unit tests of the pure homepage helper.
 * Proves:
 *   • sidebar: one "🏁 Demo Competition" entry right after "Affiliates", followed
 *     by the 4 indented sub-entries in order; every other entry unchanged; the
 *     group stays highlighted on its sub-pages
 *   • the 5 pages exist (client components under the existing /admin layout)
 *   • every fetch goes to /api/admin/demo-competition/* or
 *     /api/admin/homepage-layout only — never a real-money API
 *   • the SIMULATION notice is rendered on every page
 *   • money inputs are converted with dhToCents / percentToBps (engine.js);
 *     member and brand allocations are validated separately (no combined
 *     "≤ 100 %" rule anywhere)
 *   • archive / restore instead of delete: the URLs used, no DELETE request,
 *     archived profiles listed apart, counters on non-archived only,
 *     read-only archived editor, owner select without archived members
 *   • Live Engine: Engine OFF semantics (no catch-up), Run now disabled when
 *     off + ENGINE_DISABLED mapped, Initialize history independent of the engine
 *   • the homepage page only edits top_members / top_brands through the pure
 *     helper and refuses to save when another section would change
 *   • both layout pages (Homepage Builder + Homepage Settings) use only
 *     /api/admin/homepage-layout with a revision and handle 409 LAYOUT_CONFLICT;
 *     the builder no longer POSTs /api/setting?type=homepage_layout
 *   • homepageSections.js: add / toggle / move / count clamping / title /
 *     preservation of the other sections
 * Run: node scripts/demoCompetitionAdmin.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS ", name); } else { fail++; console.log("  FAIL ", name, extra !== undefined ? extra : ""); }
};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const DIR = "src/app/admin/demo-competition";
const walk = (d) => readdirSync(join(ROOT, d)).flatMap((n) => {
  const rel = `${d}/${n}`;
  return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
});
const uiFiles = walk(DIR).filter((f) => /\.(jsx?|mjs)$/.test(f)).sort();
const PAGES = ["page.jsx", "members/page.jsx", "brands/page.jsx", "engine/page.jsx", "homepage/page.jsx"].map((p) => `${DIR}/${p}`);

// ── 1. Sidebar ────────────────────────────────────────────────────────────────
console.log("\n1. Sidebar");
{
  const src = read("src/components/admin/SideBar.jsx");
  const entries = [...src.matchAll(/^\s*\{ href: "([^"]+)",.*label: "([^"]+)"(.*)\},\s*$/gm)].map((m) => ({ href: m[1], label: m[2], rest: m[3] }));
  const hrefs = entries.map((e) => e.href);
  const i = hrefs.indexOf("/admin/affiliates");
  const group = entries.slice(i + 1, i + 6);
  ok("the group comes right after Affiliates", i !== -1 && group[0]?.href === "/admin/demo-competition" && group[0]?.label === "🏁 Demo Competition" && /group: true/.test(group[0]?.rest));
  ok("followed by the 4 sub-entries in order", eq(group.slice(1).map((e) => [e.href, e.label]), [
    ["/admin/demo-competition/members", "Demo Members"],
    ["/admin/demo-competition/brands", "Demo Brands"],
    ["/admin/demo-competition/engine", "Live Engine"],
    ["/admin/demo-competition/homepage", "Homepage Settings"],
  ]), group);
  ok("the 4 sub-entries are indented, the group is not", group.slice(1).every((e) => /indent: true/.test(e.rest)) && !/indent/.test(group[0]?.rest || "x"));
  ok("exactly one entry per demo-competition href", hrefs.filter((h) => h.startsWith("/admin/demo-competition")).length === 5 && new Set(hrefs).size === hrefs.length);
  ok("indent style (ps-8, smaller text) only for indent entries", /indent \? "mb-1 ps-8 pe-3 py-1\.5 text-xs" : "mb-2 px-3 py-2\.5 text-sm"/.test(src));
  ok("group highlighted on any /admin/demo-competition/* path", /!!group && !isActive && !!pathname && pathname\.startsWith\(`\$\{href\}\/`\)/.test(src));
  ok("non-indent entries keep the original active / idle classes",
    /isActive \? "bg-blue-600 text-white shadow-sm" : inGroup \? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-white hover:text-gray-900 hover:shadow-sm"/.test(src));
  let headHrefs = null;
  try {
    const head = execFileSync("git", ["show", "HEAD:src/components/admin/SideBar.jsx"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    headHrefs = [...head.matchAll(/^\s*\{ href: "([^"]+)",/gm)].map((m) => m[1]);
  } catch { /* no git: skip */ }
  const notDemo = (l) => l.filter((h) => !h.startsWith("/admin/demo-competition"));
  if (headHrefs) ok(`every other sidebar entry unchanged and in the same order (${notDemo(hrefs).length})`, eq(notDemo(headHrefs), notDemo(hrefs)));
  else ok("git unavailable — sidebar order check skipped", true);
}

// ── 2. Pages ──────────────────────────────────────────────────────────────────
console.log("\n2. Pages");
for (const p of PAGES) {
  const exists = existsSync(join(ROOT, p));
  ok(`${p} exists, client component, default export`, exists && /^"use client";/.test(read(p)) && /export default function \w+\(/.test(read(p)));
}
ok("no separate admin layout / login inside the section", !existsSync(join(ROOT, DIR, "layout.jsx")) && !uiFiles.some((f) => /login/i.test(f)));
ok("the existing admin layout still guards /admin", existsSync(join(ROOT, "src/app/admin/layout.jsx")));

// ── 3. Network: only the Demo Competition admin API + the homepage layout setting ──
console.log("\n3. Requests");
{
  const ui = read(`${DIR}/_components/ui.jsx`);
  ok("API_BASE is the demo-competition admin API", /export const API_BASE = "\/api\/admin\/demo-competition";/.test(ui));
  const allFetches = [];
  for (const f of uiFiles) {
    const src = read(f);
    for (const m of src.matchAll(/\bfetch\(\s*([^,)]+)/g)) allFetches.push([f, m[1].trim()]);
  }
  const allowed = (arg) => /^`\$\{API_BASE\}\$\{path\}`$/.test(arg) || arg === "LAYOUT_URL";
  // Was 3 fetch( calls (dcApi + read layout + POST layout). The homepage page now has ONE layoutRequest() helper for GET and PUT → 2.
  ok(`every fetch( targets API_BASE or LAYOUT_URL (${allFetches.length})`, allFetches.length === 2 && allFetches.every(([, a]) => allowed(a)), allFetches);
  const home = read(`${DIR}/homepage/page.jsx`);
  // Was /api/setting?type=homepage_layout: the generic setting POST is now refused for this type; the admin layout API replaces it.
  ok("LAYOUT_URL is exactly /api/admin/homepage-layout", /const LAYOUT_URL = "\/api\/admin\/homepage-layout";/.test(home));
  const dcPaths = [];
  for (const f of uiFiles) for (const m of read(f).matchAll(/\bdcApi\(\s*(["`])([^"`]*)\1/g)) dcPaths.push(m[2]);
  ok(`every dcApi path is /members, /brands or /engine (${dcPaths.length} calls)`,
    dcPaths.length >= 14 && dcPaths.every((p) => /^\/(members|brands|engine)(\/|$)/.test(p)), dcPaths);
  const apiStrings = uiFiles.flatMap((f) => [...read(f).matchAll(/\/api\/[A-Za-z0-9_\-/?=.]*/g)].map((m) => m[0]));
  ok("no other /api/ URL anywhere in the section (no /api/setting any more)", apiStrings.every((s) => s === "/api/admin/demo-competition" || s === "/api/admin/homepage-layout"), apiStrings);
  const forbidden = /\/api\/(orders|affiliate|affiliates|admin\/affiliate|wallet|payout|deposits?|boosters?|ugc|rewards|recruiter|demo\/|admin\/demo\/|admin\/brand|brand\/)/;
  ok("no real-money / other-system API referenced", uiFiles.every((f) => !forbidden.test(read(f))));
  ok("no Prisma / service import in client files", uiFiles.every((f) => !/prisma|services\/|routeHandlers|demoService/.test(read(f))));
}

// ── 4. SIMULATION notice ─────────────────────────────────────────────────────
console.log("\n4. SIMULATION notice");
{
  const ui = read(`${DIR}/_components/ui.jsx`);
  ok("SimulationNotice says SIMULATION, fictitious, not withdrawable", /SIMULATION — données de démonstration/.test(ui) && /fictifs/.test(ui) && /retirable/.test(ui));
  for (const p of PAGES) ok(`${p} renders <SimulationNotice`, /<SimulationNotice\b/.test(read(p)));
  for (const f of ["MemberEditor.jsx", "BrandEditor.jsx"]) ok(`${f} renders <SimulationNotice`, /<SimulationNotice\b/.test(read(`${DIR}/_components/${f}`)));
}

// ── 5. Money conversions ─────────────────────────────────────────────────────
console.log("\n5. Money conversions");
{
  const ui = read(`${DIR}/_components/ui.jsx`);
  ok("ui re-exports dhToCents / percentToBps / earningsCents from engine.js",
    /import \{ dhToCents, percentToBps, earningsCents \} from "@\/lib\/demoCompetition\/engine";/.test(ui) && /export \{ dhToCents, percentToBps, earningsCents \};/.test(ui));
  const mem = read(`${DIR}/_components/MemberEditor.jsx`);
  ok("member: price → dhToCents, allocation → percentToBps",
    /priceCents: dhToCents\(f\.priceDh\)/.test(mem) && /allocationBps: percentToBps\(f\.allocationPct\)/.test(mem));
  ok("member: network price / allocation → dhToCents / percentToBps, both empty → null (network OFF)",
    /networkPriceCents: f\.networkPriceDh\.trim\(\) === "" \? null : dhToCents\(f\.networkPriceDh\)/.test(mem)
    && /networkAllocationBps: f\.networkAllocationPct\.trim\(\) === "" \? null : percentToBps\(f\.networkAllocationPct\)/.test(mem)
    && /NETWORK_RATE_INCOMPLETE/.test(mem));
  ok("member: network shows a 'not configured' state, no default network rate",
    /Non configuré/.test(mem) && /networkPriceDh: centsToInput\(m\?\.networkPriceCents \?\? null\)/.test(mem) && /networkAllocationPct: bpsToInput\(m\?\.networkAllocationBps \?\? null\)/.test(mem));
  const br = read(`${DIR}/_components/BrandEditor.jsx`);
  ok("brand: price → dhToCents, allocation → percentToBps", /priceCents: dhToCents\(f\.priceDh\)/.test(br) && /allocationBps: percentToBps\(f\.allocationPct\)/.test(br));
  ok("brand: remainder = simulated delivery / platform / confirmation costs", /coûts simulés de livraison, plateforme et confirmation/.test(br));
  const eng = read(`${DIR}/engine/page.jsx`);
  // Was "dhToCents / percentToBps + ≤ 100 % total rule": the owner dropped the combined member + brand cap (two separate
  // demo sales streams), so the expectation is now the opposite — each allocation is validated on its own against LIMITS.
  ok("engine defaults: dhToCents / percentToBps, each allocation validated on its own (LIMITS.bpsMin..bpsMax)",
    /defaultPriceCents: dhToCents\(form\.priceDh\)/.test(eng) && /defaultMemberBps: percentToBps\(form\.memberPct\)/.test(eng)
    && /defaultBrandBps: percentToBps\(form\.brandPct\)/.test(eng)
    && /const bpsOk = \(b\) => b !== null && b >= LIMITS\.bpsMin && b <= LIMITS\.bpsMax;/.test(eng)
    && /if \(!bpsOk\(body\.defaultMemberBps\)\) local\.defaultMemberBps = "INVALID_ALLOCATION";/.test(eng)
    && /if \(!bpsOk\(body\.defaultBrandBps\)\) local\.defaultBrandBps = "INVALID_ALLOCATION";/.test(eng));
  const all = uiFiles.map(read).join("\n");
  ok("no combined member + brand allocation rule / message / preview left anywhere",
    !/ALLOCATION_TOTAL_OVER_100/.test(all) && !/totalBps/.test(all) && !/≤\s*100\s*%/.test(all) && !/100 % maximum/.test(all)
    && !/Membre \+ marque/i.test(all) && !/Total membre \+ marque/.test(all) && !/defaultMemberBps \+ body\.defaultBrandBps/.test(all));
  ok("engine page says the two allocations are independent", /indépendantes/.test(eng) && /validée séparément/.test(eng));
  const parts = read(`${DIR}/_components/ProfileParts.jsx`);
  ok("live preview '1 commande démo = X DH' from previewPerOrder (engine earningsCents)",
    /1 commande démo = <strong>\{fmtDh\(p\.earningsCents\)\}/.test(parts) && /earningsCents: earningsCents\(1, c, b\)/.test(ui));
  ok("no hand-rolled ×100 conversion in editors / engine page", [mem, br, eng].every((s) => !/\*\s*100\b|\/\s*100\b/.test(s)));
}

// ── 6. Business rules surfaced in the UI ─────────────────────────────────────
console.log("\n6. Rules in the UI");
{
  const ui = read(`${DIR}/_components/ui.jsx`);
  ok("future-only copy (Casablanca next day for min/max)", /futurs/.test(ui) && /Casablanca/.test(ui));
  const members = read(`${DIR}/members/page.jsx`), brands = read(`${DIR}/brands/page.jsx`);
  // Counters now count NON-archived profiles only: `members` / `brands` are the `current` half of splitArchived().
  ok("members: x / 21 counter on non-archived members and create disabled when full",
    /const \{ current: members, archived \} = splitArchived\(list\?\.members\);/.test(members)
    && /<Counter value=\{members\.length\} max=\{max\}/.test(members) && /const full = members\.length >= max;/.test(members)
    && /disabled=\{!list \|\| full\}/.test(members) && /MAX_MEMBERS/.test(members));
  ok("brands: x / 20 counter on non-archived brands and create disabled when full",
    /const \{ current: brands, archived \} = splitArchived\(list\?\.brands\);/.test(brands)
    && /<Counter value=\{brands\.length\} max=\{max\}/.test(brands) && /const full = brands\.length >= max;/.test(brands)
    && /disabled=\{!list \|\| full \|\| noMembers\}/.test(brands) && /MAX_BRANDS/.test(brands));
  const mem = read(`${DIR}/_components/MemberEditor.jsx`), br = read(`${DIR}/_components/BrandEditor.jsx`);
  const parts = read(`${DIR}/_components/ProfileParts.jsx`);
  // Was "delete only when disabled (and member owns no brands)": permanent delete is gone; archiving replaces it (section 10).
  // A member can be archived only once it owns no NON-archived brand; the reason is shown.
  ok("archive: member blocked while it owns non-archived brands (reason shown), confirm dialog on both editors",
    /const liveBrands = brands\.filter\(\(b\) => !b\.archivedAt\);/.test(mem) && /const archiveBlockers = liveBrands\.length/.test(mem)
    && /disabled=\{!can \|\| busy\}/.test(parts) && /window\.confirm\(`Archiver/.test(mem) && /window\.confirm\(`Archiver/.test(br));
  // DISABLE_FIRST belonged to the removed DELETE routes → no longer mapped; ARCHIVED / OWNER_ARCHIVED / ENGINE_DISABLED are new.
  ok("MEMBER_OWNS_BRANDS / ARCHIVED / OWNER_ARCHIVED / ENGINE_DISABLED / limits mapped to French",
    ["MEMBER_OWNS_BRANDS", "ARCHIVED", "OWNER_ARCHIVED", "ENGINE_DISABLED", "MEMBER_LIMIT_REACHED", "BRAND_LIMIT_REACHED", "IMAGE_TOO_LARGE", "INVALID_IMAGE_TYPE"].every((c) => new RegExp(`\\b${c}: "`).test(ui))
    && !/DISABLE_FIRST/.test(ui));
  // ALLOCATION_TOTAL_OVER_100 no longer exists on the API; OWNER_ARCHIVED is the new ownerId field error.
  ok("every field code mapped", ["INVALID_NAME", "INVALID_MIN_ORDERS", "INVALID_MAX_ORDERS", "MAX_BELOW_MIN", "INVALID_PRICE", "INVALID_ALLOCATION", "INVALID_AFFILIATES", "NETWORK_RATE_INCOMPLETE", "OWNER_REQUIRED", "OWNER_NOT_FOUND", "OWNER_ARCHIVED", "INVALID_TYPE"].every((c) => new RegExp(`${c}: "`).test(ui.slice(ui.indexOf("export const FIELD_TEXT")))));
  ok("server field keys networkmin/networkmax normalized to the form keys", /network\(min\|max\)DailyOrders/.test(ui));
  ok("image upload: JPEG/PNG/WebP ≤ 5 MB checked client-side, multipart field 'file'",
    /\["image\/jpeg", "image\/png", "image\/webp"\]/.test(ui) && /5 \* 1024 \* 1024/.test(ui) && /form\.append\("file", file\)/.test(parts) && /accept="image\/jpeg,image\/png,image\/webp"/.test(parts));
  ok("photo / image endpoints", /path=\{`\/members\/\$\{id\}\/photo`\}/.test(mem) && /path=\{`\/brands\/\$\{id\}\/image`\}/.test(br));
  const eng = read(`${DIR}/engine/page.jsx`);
  ok("engine: toggle (PATCH), run (POST), initialize (POST, confirm, disabled when complete)",
    /dcApi\("\/engine", \{ method: "PATCH", body: \{ enabled: !state\.engine\.enabled \} \}\)/.test(eng) && /dcApi\("\/engine\/run", \{ method: "POST" \}\)/.test(eng)
    && /dcApi\("\/engine\/initialize", \{ method: "POST" \}\)/.test(eng) && /window\.confirm/.test(eng) && /disabled=\{!!busy \|\| complete\}/.test(eng) && /idempotente/.test(eng));
  ok("engine: explains server-side deterministic generation, Casablanca days, worker + page-visit catch-up",
    /côté serveur/.test(eng) && /déterministe/.test(eng) && /Africa\/Casablanca/.test(eng) && /demo-leaderboard-engine/.test(eng) && /visites/.test(eng));
  ok("engine OFF: no activity for that period, resumes at the current time (no catch-up)",
    eng.includes("Moteur désactivé = aucune activité générée pour cette période ; à la réactivation, la simulation reprend à l&apos;heure actuelle (pas de rattrapage)."));
  ok("Run now disabled while the engine is off; ENGINE_DISABLED mapped in ui.jsx",
    /onClick=\{run\} disabled=\{!!busy \|\| !engine\.enabled\}/.test(eng) && /ENGINE_DISABLED: "/.test(ui));
  ok("Initialize: each created profile gets its 30-day history immediately, engine on or off (confirm + explanation)",
    /window\.confirm\(`[^`]*Chaque profil créé reçoit immédiatement ses 30 jours d'historique démo, même si le moteur est désactivé/.test(eng)
    && /même si le moteur est désactivé<\/strong>/.test(eng) && !/seule l&apos;initialisation/.test(eng));
  ok("engine counts show archived profiles apart", /counts\.archivedMembers/.test(eng) && /counts\.archivedBrands/.test(eng));
}

// ── 7. Homepage page ─────────────────────────────────────────────────────────
console.log("\n7. Homepage settings page");
{
  const home = read(`${DIR}/homepage/page.jsx`);
  ok("edits go through the pure helper only", /from "@\/lib\/demoCompetition\/homepageSections"/.test(home)
    && !/\.filter\(|\.splice\(|\.pop\(|\.shift\(/.test(home));
  // Was "re-reads before saving": the revision now replaces the re-read (the server answers 409 when someone saved meanwhile).
  ok("refuses to save if other sections would change (guard kept, against the loaded server state)",
    /preservesOtherSections\(serverSections, next\)/.test(home) && !/readLayout|const fresh/.test(home));
  // Was "saves POST {…setting, sections}": now PUT { sections, revision } to /api/admin/homepage-layout.
  ok("saves PUT { sections, revision } through the layout API", /layoutRequest\("PUT", \{ sections: next, revision \}\)/.test(home)
    && /fetch\(LAYOUT_URL, \{\s*method,/.test(home) && !/method: "POST"/.test(home));
  ok("409 LAYOUT_CONFLICT → reloads the server state and shows the message (never overwrites)",
    /r\.status === 409 && r\.data\?\.code === "LAYOUT_CONFLICT"/.test(home) && /adopt\(r\.data\); else await load\(\);/.test(home)
    && /setNotice\(\{ ok: false, text: CONFLICT_TEXT \}\)/.test(home) && /modifiée ailleurs/.test(home));
  ok("other save failures shown (session / INVALID_LAYOUT / network / status)", /INVALID_LAYOUT/.test(home) && /saveErrorText\(r\)/.test(home));
  ok("no layout saved yet (sections null / empty) → adding is blocked (would replace the default homepage)",
    /const hasLayout = asSections\(serverSections\)\.length > 0;/.test(home) && /canAdd=\{hasLayout\}/.test(home) && /disabled=\{!canAdd\}/.test(home)
    && /Aucun layout personnalisé n&apos;est enregistré/.test(home));
  ok("only the two managed types are offered", /Object\.keys\(DEMO_HOMEPAGE_TYPES\)\.map/.test(home));
  ok("does not touch the builder / renderer files", !/HomeBuilder|homepage-builder\/page/.test(home.replace(/href="\/admin\/homepage-builder"/g, "")));
}

// ── 8. Named imports resolve ─────────────────────────────────────────────────
console.log("\n8. Imports");
{
  const exportsOf = (rel) => {
    const s = read(rel);
    const names = new Set([...s.matchAll(/export (?:async )?(?:function|const|let|class) (\w+)/g)].map((m) => m[1]));
    for (const m of s.matchAll(/export \{([^}]+)\}/g)) for (const n of m[1].split(",")) names.add(n.trim().split(/\s+as\s+/).pop());
    return names;
  };
  const targetOf = (from, spec) => {
    if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
    if (spec.startsWith(".")) return join(dirname(from), spec).replace(/\\/g, "/");
    return null;
  };
  const missing = [];
  for (const f of uiFiles) {
    for (const m of read(f).matchAll(/import \{([^}]+)\} from "([^"]+)"/g)) {
      const base = targetOf(f, m[2]);
      if (!base) continue;
      const file = [".jsx", ".js", ""].map((x) => base + x).find((p) => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile());
      if (!file) { missing.push(`${f}: ${m[2]}`); continue; }
      const ex = exportsOf(file);
      for (const n of m[1].split(",").map((x) => x.trim()).filter(Boolean)) if (!ex.has(n)) missing.push(`${f}: ${n} from ${m[2]}`);
    }
  }
  ok("every named import from local / @ modules exists", missing.length === 0, missing);
}

// ── 9. Archive / restore (no permanent delete) ──────────────────────────────
console.log("\n9. Archive / restore");
{
  const ui = read(`${DIR}/_components/ui.jsx`);
  const parts = read(`${DIR}/_components/ProfileParts.jsx`);
  const mem = read(`${DIR}/_components/MemberEditor.jsx`), br = read(`${DIR}/_components/BrandEditor.jsx`);
  const members = read(`${DIR}/members/page.jsx`), brands = read(`${DIR}/brands/page.jsx`);
  const hub = read(`${DIR}/page.jsx`);
  const all = uiFiles.map(read).join("\n");

  ok("no DELETE request anywhere in the section", !/method: "DELETE"/.test(all) && !/["']DELETE["']/.test(all));
  ok("no delete UI left (DeleteZone / onDeleted / Supprimer définitivement)", !/DeleteZone|onDeleted|Supprimer définitivement|Trash2/.test(all));
  ok("member archive / restore URLs (POST)", /dcApi\(`\/members\/\$\{id\}\/archive`, \{ method: "POST" \}\)/.test(mem)
    && /dcApi\(`\/members\/\$\{id\}\/restore`, \{ method: "POST" \}\)/.test(mem)
    && /dcApi\(`\/members\/\$\{m\.id\}\/restore`, \{ method: "POST" \}\)/.test(members));
  ok("brand archive / restore URLs (POST)", /dcApi\(`\/brands\/\$\{id\}\/archive`, \{ method: "POST" \}\)/.test(br)
    && /dcApi\(`\/brands\/\$\{id\}\/restore`, \{ method: "POST" \}\)/.test(br)
    && /dcApi\(`\/brands\/\$\{b\.id\}\/restore`, \{ method: "POST" \}\)/.test(brands));
  const dcCalls = [...all.matchAll(/\bdcApi\(\s*(["`])([^"`]*)\1(?:,\s*\{\s*method:\s*"(\w+)")?/g)].map((m) => [m[3] || "GET", m[2]]);
  const archiveCalls = dcCalls.filter(([, p]) => /\/(archive|restore)$/.test(p));
  ok(`every archive / restore call is a POST on /members|/brands/{id}/archive|restore (${archiveCalls.length})`,
    archiveCalls.length === 6 && archiveCalls.every(([m, p]) => m === "POST" && /^\/(members|brands)\/\$\{(id|m\.id|b\.id)\}\/(archive|restore)$/.test(p)), archiveCalls);
  ok("ArchiveZone explains: disabled, gone from public rankings, history kept, restorable",
    /export function ArchiveZone/.test(parts) && /disparaît des classements publics/.test(parts) && /historique démo est <strong>conservé<\/strong>/.test(parts) && /restaurer/.test(parts));
  ok("both editors render ArchiveZone (non-archived) and ArchivedBanner with Restore (archived)",
    [mem, br].every((s) => /\{!archived && <ArchiveZone /.test(s) && /\{archived && <ArchivedBanner /.test(s) && /onRestore=\{restore\}/.test(s)));
  ok("archived profile opens read-only (fieldset disabled, no save button, no image upload)",
    [mem, br].every((s) => /const archived = !!detail\?\.archivedAt;/.test(s) && /<fieldset disabled=\{archived\}/.test(s)
      && /\{!archived && \(\s*<div className="flex justify-end">/.test(s) && /\{!creating && !archived && \(/.test(s)));
  ok("restore comes back disabled: the editor says to re-enable it", /restauré, mais désactivé/.test(mem) && /restaurée, mais désactivée/.test(br) && /reviendra <strong>désactivé<\/strong>/.test(parts));
  ok("lists: archived profiles in a collapsible 'Archivés (n)' section with Restore",
    /export function ArchivedSection/.test(ui) && /Archivés \(\{count\}\)/.test(ui) && /aria-expanded=\{open\}/.test(ui)
    && [members, brands].every((s) => /<ArchivedSection count=\{archived\.length\}>/.test(s) && /Restaurer/.test(s)));
  ok("splitArchived keeps active + disabled in the main list, archived apart", (() => {
    const fn = ui.match(/export function splitArchived\(rows\) \{[\s\S]*?\n\}/)?.[0];
    if (!fn) return false;
    const splitArchived = new Function(`${fn.replace("export ", "")}; return splitArchived;`)();
    const r = splitArchived([{ id: 1, active: true, archivedAt: null }, { id: 2, active: false, archivedAt: null }, { id: 3, active: false, archivedAt: "2026-11-01T00:00:00.000Z" }]);
    return eq(r.current.map((x) => x.id), [1, 2]) && eq(r.archived.map((x) => x.id), [3]) && eq(splitArchived(undefined), { current: [], archived: [] });
  })());
  ok("restore disabled when the limit of non-archived profiles is reached (members + brands), brand also when its owner is archived",
    /disabled=\{full \|\| restoring !== null\}/.test(members) && /const blocked = full \|\| ownerArchived;/.test(brands) && /full=\{full\}/.test(members) && /full=\{full\}/.test(brands));
  ok("brand owner select lists only non-archived members", /const selectable = members\.filter\(\(m\) => !m\.archivedAt\);/.test(br)
    && /\{options\.map\(\(m\) => \(/.test(br) && /archivedAt: archivedAt \?\? null/.test(brands) && /const noMembers = list && !members\.some\(\(m\) => !m\.archivedAt\);/.test(brands));
  ok("hub shows archived counts apart", /counts\?\.archivedMembers/.test(hub) && /counts\?\.archivedBrands/.test(hub));
}

// ── 10. Homepage Builder ↔ Homepage Settings (shared layout API with revision) ──
console.log("\n10. Homepage layout API (builder + settings)");
{
  const builder = read("src/app/admin/homepage-builder/page.jsx");
  const home = read(`${DIR}/homepage/page.jsx`);
  for (const [name, src] of [["builder", builder], ["settings", home]]) {
    ok(`${name}: LAYOUT_URL = /api/admin/homepage-layout`, /const LAYOUT_URL = "\/api\/admin\/homepage-layout";/.test(src));
    ok(`${name}: GET then PUT { sections, revision }`, /layoutRequest\("GET"\)/.test(src) && /layoutRequest\("PUT", \{ sections(: next)?, revision \}\)/.test(src));
    ok(`${name}: handles 409 LAYOUT_CONFLICT`, /r\.status === 409 && r\.data\?\.code === "LAYOUT_CONFLICT"/.test(src));
    // The builder still POSTs other endpoints (e.g. /api/admin/store-map/resolve): only the layout setting is forbidden.
    ok(`${name}: no request to /api/setting?type=homepage_layout`, !/fetch\(\s*["'`]\/api\/setting/.test(src) && !/["'`]\/api\/setting\?type=homepage_layout["'`]\s*,\s*\{[^}]*method/.test(src));
  }
  ok("builder: the only layout fetch is LAYOUT_URL", [...builder.matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1].trim()).filter((a) => /layout|LAYOUT|setting/.test(a)).every((a) => a === "LAYOUT_URL"));
  ok("builder: keeps the revision, stores the new one after a successful save", /const \[revision, +setRevision\] += useState\(null\);/.test(builder)
    && /setRevision\(r\.data\.revision\);/.test(builder));
  ok("builder: null sections → the existing default sections", /setSections\(Array\.isArray\(r\.data\.sections\) \? r\.data\.sections : defaultSections\(\)\);/.test(builder)
    && /type: "slider"/.test(builder) && /type: "support"/.test(builder));
  ok("builder: 409 → French banner + Recharger button, save blocked until reload (never overwrites silently)",
    builder.includes("La mise en page a été modifiée ailleurs (ex. Demo Competition → Homepage Settings). Rechargez pour récupérer la dernière version — vos modifications non enregistrées seraient perdues.")
    && /setConflict\(true\)/.test(builder) && /<button onClick=\{load\}[^>]*>Recharger<\/button>/.test(builder) && /disabled=\{saving \|\| !revision \|\| conflict\}/.test(builder));
  ok("builder: any other save failure is shown (no silent catch)", /setError\(/.test(builder) && /Échec de l'enregistrement/.test(builder) && !/catch \(e\) \{ console\.error\(e\); \}/.test(builder));
  ok("settings: no 're-read before save' logic left", !/readLayout|const fresh|\.\.\.fresh/.test(home));
}

// ── 11. homepageSections.js (pure) ───────────────────────────────────────────
console.log("\n11. homepageSections helper");
{
  const H = await import("../src/lib/demoCompetition/homepageSections.js");
  const base = () => [
    { id: "sec_1_1", type: "slider", visible: true, data: {} },
    { id: "sec_1_2", type: "products", visible: true, data: { title: "Featured", limit: 8 } },
    { id: "sec_1_3", type: "reviews", visible: false, data: { x: 1 } },
  ];
  const frozen = JSON.stringify(base());

  ok("defaults match the renderer / builder (previewCount 5)", H.DEMO_HOMEPAGE_TYPES.top_members.defaultCount === 5 && H.DEMO_HOMEPAGE_TYPES.top_brands.defaultCount === 5);
  ok("bounds: members 1..21, brands 1..20", H.DEMO_HOMEPAGE_TYPES.top_members.max === 21 && H.DEMO_HOMEPAGE_TYPES.top_brands.max === 20
    && H.DEMO_HOMEPAGE_TYPES.top_members.min === 1 && H.DEMO_HOMEPAGE_TYPES.top_brands.min === 1);

  const b0 = base();
  const a1 = H.addSection(b0, "top_members", { nowMs: 1700, seq: 1 });
  ok("add appends at the end with builder id format and defaults", a1.length === 4 && eq(a1[3], { id: "sec_1700_1", type: "top_members", visible: true, data: { title: "", previewCount: 5, showViewAll: true } }));
  ok("add leaves the input array and the other sections untouched", JSON.stringify(b0) === frozen && eq(a1.slice(0, 3), base()) && H.preservesOtherSections(b0, a1));
  ok("add is idempotent (same array when the type exists)", H.addSection(a1, "top_members", { nowMs: 9, seq: 1 }) === a1);
  const a2 = H.addSection(a1, "top_brands", { nowMs: 1700, seq: 1 });
  ok("add avoids an id collision", a2[4].id === "sec_1700_2" && a2[4].type === "top_brands");
  ok("add on a non-array layout → one section", eq(H.addSection(undefined, "top_brands", { nowMs: 5, seq: 3 }).map((s) => s.id), ["sec_5_3"]));

  const v = H.setSectionVisible(a2, "top_members", false);
  ok("toggle visible", v[3].visible === false && H.setSectionVisible(v, "top_members", true)[3].visible === true && H.preservesOtherSections(a2, v) && eq(v[4], a2[4]));
  ok("toggle on a missing type is a no-op", H.setSectionVisible(base(), "top_members", false).length === 3);

  const up = H.moveSection(a2, "top_members", -1);
  ok("move up swaps with the previous section", eq(up.map((s) => s.type), ["slider", "products", "top_members", "reviews", "top_brands"]) && H.preservesOtherSections(a2, up));
  const down = H.moveSection(a2, "top_members", +1);
  ok("move down swaps with the next section", eq(down.map((s) => s.type), ["slider", "products", "reviews", "top_brands", "top_members"]));
  ok("move down at the end / up at the top = no-op", H.moveSection(a2, "top_brands", +1) === a2 && H.moveSection(H.moveSection(H.moveSection(H.moveSection(a2, "top_members", -1), "top_members", -1), "top_members", -1), "top_members", -1)[0].type === "top_members");
  let top = a2; for (let k = 0; k < 10; k++) top = H.moveSection(top, "top_brands", -1);
  ok("moving to the top keeps the other sections' relative order", top[0].type === "top_brands" && H.preservesOtherSections(a2, top));

  const c = (t, val) => H.clampPreviewCount(t, val);
  ok("count clamping (members)", c("top_members", 0) === 1 && c("top_members", -5) === 1 && c("top_members", 22) === 21 && c("top_members", 21) === 21 && c("top_members", "7") === 7 && c("top_members", 5.6) === 6);
  ok("count clamping (brands) + invalid → default", c("top_brands", 21) === 20 && c("top_brands", 99) === 20 && c("top_brands", "abc") === 5 && c("top_brands", null) === 5 && c("top_brands", "") === 5);

  const u = H.updateSectionData(a2, "top_brands", { previewCount: 50, title: "  Nos   marques ", showViewAll: 0 });
  ok("update data: clamps the count, normalizes title, boolean view-all", eq(u[4].data, { title: "Nos marques ", previewCount: 20, showViewAll: false }) && H.preservesOtherSections(a2, u) && eq(u[3], a2[3]));
  ok("update keeps unknown data keys", H.updateSectionData([{ id: "s", type: "top_members", visible: true, data: { extra: 1 } }], "top_members", { previewCount: 3 })[0].data.extra === 1);
  ok("title capped at 80 chars", H.updateSectionData(a2, "top_members", { title: "x".repeat(200) })[3].data.title.length === H.TITLE_MAX);
  ok("finalize trims managed titles only", H.finalizeSections(u)[4].data.title === "Nos marques" && H.finalizeSections(u)[1] === u[1]);

  const d = H.describeSection(a2, "top_members");
  ok("describe: index, neighbours, values", d.present && d.index === 3 && d.total === 5 && d.prevType === "reviews" && d.nextType === "top_brands" && d.previewCount === 5 && d.showViewAll === true && d.visible === true);
  ok("describe: missing type", H.describeSection(base(), "top_brands").present === false);
  ok("describe: clamps a stored out-of-range count", H.describeSection([{ id: "s", type: "top_members", visible: true, data: { previewCount: 500 } }], "top_members").previewCount === 21);

  const dup = [...a2, { id: "sec_9_9", type: "top_members", visible: true, data: { previewCount: 4 } }];
  const dupU = H.updateSectionData(dup, "top_members", { previewCount: 2 });
  ok("duplicates: only the first occurrence is edited", dupU[3].data.previewCount === 2 && dupU[5].data.previewCount === 4 && H.describeSection(dup, "top_members").duplicates === 1);

  ok("unknown type throws", (() => { try { H.addSection(a2, "hero"); return false; } catch { return true; } })());
  ok("preservesOtherSections detects a change to another section",
    !H.preservesOtherSections(a2, a2.map((s) => (s.type === "products" ? { ...s, data: { ...s.data, limit: 9 } } : s)))
    && !H.preservesOtherSections(a2, a2.filter((s) => s.type !== "reviews"))
    && !H.preservesOtherSections(a2, [a2[1], a2[0], ...a2.slice(2)]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
