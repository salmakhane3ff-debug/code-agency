#!/usr/bin/env node
/**
 * scripts/migrationBaseline.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3C-9A — squashed migration baseline. Static checks only (no database;
 * the PostgreSQL behaviour was rehearsed separately on a throwaway local
 * cluster, see prisma/migrations/README.md). Proves:
 *   • the guard is the first statement and precedes every DDL statement
 *   • every schema.prisma table / enum is created; the guard knows every enum
 *   • every custom SQL object (CHECK, function, trigger, partial / expression
 *     index) is present, copied verbatim from the archived migration
 *   • no duplicate / contradictory index (plain collections_slug_key removed)
 *   • the active folder holds only the baseline; the 28 archived migrations are
 *     preserved byte for byte (pinned sha256)
 *   • docs describe the fresh- and existing-database procedures
 * Run: node scripts/migrationBaseline.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const path = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), "utf8");
const sha = (p) => createHash("sha256").update(readFileSync(path(p))).digest("hex");

const BASELINE = "20261025000000_baseline";
const sql = read(`prisma/migrations/${BASELINE}/migration.sql`);
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"); // comments stripped
const schema = read("prisma/schema.prisma");

// Pinned before the git-mv in Phase 3C-9A (sha256 of each migration.sql).
const ARCHIVE_SHA256 = {
  "20260316214921_phase1_add_promo_spin_shipping_reviews_invoice_campaigns": "915274d3cc2c8eb3d50ec503e22c45c7c583b3180d7a5b9588adb70e74943ef2",
  "20260316_add_content_items": "1ae7e56c23145171d0330d9c07f591bf5158a1358be218e1beafc75f9b4ec2f8",
  "20260316_add_posts_images": "28b0567363ca75bf160d1f1bf7878c4942550133e8bdcfc45b3a002b858ade7f",
  "20260316_init": "491fdd4a9f1838bd64b5878c60f068895ca3a3ac500cdf6fc13a80cfd55d483a",
  "20260422_add_gift_countdown": "c597487b8955fb447348f22b891d518cbbb2da7067392c3a1b96999ca7314d02",
  "20260423_abandoned_cart_orderid": "405fe5f7ae4246e36755b0c737532e7ec2fb8a58193a5caae1208f51adde41b8",
  "20260423_add_abandoned_carts": "f28d355604706548c8dbc507434adb8c8447ebaf9c98e651f45c0265d6d9cd01",
  "20260627_add_bemob_tracking": "e45f5f286433a11ed4e737742f9b5da18cd58345a8eff2482c5ea2882dab80cd",
  "20260630_affiliate_goals": "d19d53c5189cbc5d1a983b42788c7828b59ee4e2bc6aff55b549685d93909c7e",
  "20260716_product_feed_index": "fbb5d7058a2089c6f565f12c423d110fde870a7d2df2879628673f9ce8b1c2c0",
  "20260717_duplicate_detector": "f0c05647bf91cb6189c242473b0ca9ac9e5b6bee16414329053e79ef6416d221",
  "20260720_ugc_module": "24dfa0ea5b955d392fe8d1a4c72c982f43997cdd62c048063ee08277528a46cf",
  "20260721_ugc_audit_notifications": "1dfddb5cc053b738c479405fb08809e28c9fe7e81745ea1b869b3e1bc9447c15",
  "20260722_ugc_daily_targets": "75e11539a6b87d466751eff294ee7a65e9837facd50eec80e77777bcc2ad9886",
  "20260723_demo_avatars_ugc": "426f084f1cddf171d6b2e9b7723264209b16ee019a32ffadfad8a290a41632d4",
  "20260724_fake_orders_engine": "728cabb0c995a6e0b559ba744f90a2b6f8bbe54924ff69e00c6300789c32785f",
  "20260725_identity_verification": "e6730d477782c943f629d7c11f843c8e557634db6c67d0db255570d5073e9edb",
  "20260726_product_purchase_flow": "7bd0e0410abfa1bbb95686c09ae21e98dc2b8c1351d1b9f4d85ebdb8bc2455e3",
  "20260727_affiliate_security_deposit": "e10b736e5289bfd9c6d0a00508ab71e7829106780ed2b1b978422f2ff320c08e",
  "20260727_demo_auto_simulation": "3e76eaaa8688398b2ba9fe5a3cd4c42a8fcbc3b0f8378106bd87141efaa0f7b9",
  "20260731_booster_purchases": "784723d3b8a86278a1ad5e6d367e7c01dd633b9e585e74c135e6bb6ff726def2",
  "20260801_booster_payment_split": "d2bcb0253763d8514a53808620431f5f55506f33904a7e169e8764c8a4f82625",
  "20260802_booster_simulation": "1de776caad5d692bca765da3b49c7d8318ae2d41cbcd1264afbd7c96d9a24bd5",
  "20260806_feedback_review_date": "c2b6e7a6a21056378c36187005b5381cd70d526c28559a53208c886b46503c9b",
  "20261019_affiliate_rewards": "6536de3c2c65e9b351d716263417dd1fe1301ee54ddd2430ae0cfc884c4cac01",
  "20261020_product_lock": "372f25461ec6c7aa3bbc721fa74c7315362ac3d742bd70e7fe7ed30df372afc8",
  "20261023_demo_chat_journeys": "27413ed0ddbff982178bbd7d1ee01ff37604a9076a4663e1dc66d8b5f272c1c8",
  "20261024_demo_chat_audit_truncate_guard": "c2130eead571b37a63ef841293141e249023a824cf1050fca30793908b7aa549",
};

// ── 1. Guard ──────────────────────────────────────────────────────────────────
console.log("\n1. Guard before any DDL");
{
  const firstStmt = code.trimStart();
  const guardEnd = code.indexOf("END $$;");
  const firstDdl = code.search(/\b(CREATE|ALTER|DROP)\s+(SCHEMA|TYPE|TABLE|INDEX|UNIQUE|FUNCTION|OR\s+REPLACE|TRIGGER)/);
  ok("first statement is the guard DO block", firstStmt.startsWith("DO $$") && /BASELINE REFUSED/.test(firstStmt.slice(0, guardEnd)));
  ok("guard ends before the first DDL statement", guardEnd > 0 && firstDdl > guardEnd);
  const guard = code.slice(0, guardEnd);
  ok("guard checks existing tables (except _prisma_migrations) in current_schema()", /pg_catalog\.pg_tables/.test(guard) && /schemaname = current_schema\(\)/.test(guard) && /tablename <> '_prisma_migrations'/.test(guard));
  const enums = [...schema.matchAll(/^enum (\w+)/gm)].map((m) => m[1]);
  ok(`guard checks all ${enums.length} schema enum types`, enums.length > 0 && enums.every((e) => guard.includes(`'${e}'`)));
  ok("guard raises (P0001) with the resolve instruction and 'Nothing was changed'", /RAISE EXCEPTION/.test(guard) && /ERRCODE = 'P0001'/.test(guard) && guard.includes(`migrate resolve --applied ${BASELINE}`) && /Nothing was changed/.test(guard));
  ok("no explicit BEGIN/COMMIT (script stays one implicit transaction)", !/^\s*(BEGIN|COMMIT)\s*;/im.test(code));
}

// ── 2. Schema coverage ────────────────────────────────────────────────────────
console.log("\n2. Complete schema");
{
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => body.match(/@@map\("(\w+)"\)/)?.[1] ?? name);
  const created = new Set([...code.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]));
  const missing = models.filter((t) => !created.has(t));
  ok(`all ${models.length} schema tables created${missing.length ? ` — missing ${missing.join(", ")}` : ""}`, models.length === 78 && missing.length === 0);
  ok("no table created twice / outside the schema", created.size === models.length);
  const enums = [...schema.matchAll(/^enum (\w+)/gm)].map((m) => m[1]);
  ok("every enum type created", enums.every((e) => code.includes(`CREATE TYPE "${e}"`)));
  for (const t of ["affiliate_orders", "demo_affiliates", "gifts", "demo_settings", "affiliate_notifications", "demo_earnings_history"]) {
    ok(`previously chain-less table "${t}" is created`, created.has(t));
  }
  ok("generated with Prisma (Prisma section markers present)", /-- CreateTable/.test(sql) && /-- AddForeignKey/.test(sql));
}

// ── 3. Custom SQL objects ─────────────────────────────────────────────────────
console.log("\n3. Custom SQL objects (verbatim from the archive)");
{
  const CHECKS = [
    "reward_gifts_values_check", "reward_points_ledger_values_check", "reward_order_awards_values_check",
    "reward_redemptions_values_check", "reward_redemption_history_values_check",
    "demo_chat_journeys_values_check", "demo_chat_journey_steps_values_check", "demo_chat_journey_steps_shape_check",
    "demo_chat_journey_versions_values_check", "demo_chat_assets_values_check", "demo_chat_assignments_values_check",
    "demo_chat_messages_values_check", "demo_chat_audit_log_values_check", "demo_sim_day_coverage_values_check",
  ];
  const checks = [...code.matchAll(/ADD CONSTRAINT "(\w+)" CHECK/g)].map((m) => m[1]);
  ok(`all ${CHECKS.length} named CHECK constraints, each once`, CHECKS.every((c) => checks.filter((x) => x === c).length === 1) && checks.length === CHECKS.length);
  ok("functions reward_reject_mutation + demo_chat_reject_mutation", /CREATE OR REPLACE FUNCTION "reward_reject_mutation"\(\)/.test(code) && /CREATE OR REPLACE FUNCTION "demo_chat_reject_mutation"\(\)/.test(code));
  const trig = (name, table, timing, fn) => new RegExp(`CREATE TRIGGER "${name}"\\s+${timing} ON "${table}"\\s+FOR EACH (ROW|STATEMENT) EXECUTE PROCEDURE "${fn}"\\(\\)`).test(code);
  ok("rewards ledger append-only trigger (BEFORE UPDATE OR DELETE)", trig("reward_points_ledger_append_only", "reward_points_ledger", "BEFORE UPDATE OR DELETE", "reward_reject_mutation"));
  ok("rewards redemption history append-only trigger", trig("reward_redemption_history_append_only", "reward_redemption_history", "BEFORE UPDATE OR DELETE", "reward_reject_mutation"));
  ok("demo chat audit append-only trigger", trig("demo_chat_audit_log_append_only", "demo_chat_audit_log", "BEFORE UPDATE OR DELETE", "demo_chat_reject_mutation"));
  ok("demo chat audit TRUNCATE guard (statement level)", /CREATE TRIGGER "demo_chat_audit_log_no_truncate"\s+BEFORE TRUNCATE ON "demo_chat_audit_log"\s+FOR EACH STATEMENT/.test(code));
  ok("functions are created before the triggers that use them",
    code.indexOf('FUNCTION "reward_reject_mutation"') < code.indexOf('CREATE TRIGGER "reward_points_ledger_append_only"')
    && code.indexOf('FUNCTION "demo_chat_reject_mutation"') < code.indexOf('CREATE TRIGGER "demo_chat_audit_log_append_only"')
    && code.indexOf('CREATE TRIGGER "demo_chat_audit_log_append_only"') < code.indexOf('CREATE TRIGGER "demo_chat_audit_log_no_truncate"'));
  const idx = (name) => [...code.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "${name}"[^;]*;`, "g"))].map((m) => m[0].replace(/\s+/g, " "));
  const slug = idx("collections_slug_key");
  ok("collections_slug_key: exactly one, the PARTIAL unique index (plain variant removed)", slug.length === 1 && /UNIQUE INDEX "collections_slug_key" ON "collections"\("slug"\) WHERE "slug" IS NOT NULL;/.test(slug[0]));
  ok("products_title_key_idx expression index", idx("products_title_key_idx").length === 1 && /lower\(btrim\("title"\)\)/.test(idx("products_title_key_idx")[0]));
  ok("products_sku_key_idx partial expression index", idx("products_sku_key_idx").length === 1 && /btrim\("sku"\)\) WHERE "sku" IS NOT NULL AND btrim\("sku"\) <> ''/.test(idx("products_sku_key_idx")[0]));
  ok("products_barcode_key_idx partial expression index", idx("products_barcode_key_idx").length === 1 && /WHERE "barcode" IS NOT NULL AND btrim\("barcode"\) <> ''/.test(idx("products_barcode_key_idx")[0]));
  ok("affiliate_security_deposits_one_pending partial unique index", idx("affiliate_security_deposits_one_pending").length === 1 && /UNIQUE INDEX IF NOT EXISTS "affiliate_security_deposits_one_pending" ON "affiliate_security_deposits" \("affiliateId"\) WHERE "status" = 'PENDING';/.test(idx("affiliate_security_deposits_one_pending")[0]));
  const names = [...code.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "(\w+)"/g)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  ok(`no index name created twice${dup.length ? ` — ${dup.join(", ")}` : ""}`, dup.length === 0);
  const A = "prisma/migrations_archive";
  const tailFrom = (p, marker) => { const s = read(p); return s.slice(s.indexOf(marker)).trim(); };
  ok("rewards custom section is verbatim from 20261019_affiliate_rewards", sql.includes(tailFrom(`${A}/20261019_affiliate_rewards/migration.sql`, "-- ── CHECK constraints")));
  ok("demo chat custom section is verbatim from 20261023_demo_chat_journeys", sql.includes(tailFrom(`${A}/20261023_demo_chat_journeys/migration.sql`, "-- ── CHECK constraints")));
  const t = read(`${A}/20261024_demo_chat_audit_truncate_guard/migration.sql`);
  ok("TRUNCATE guard is verbatim from 20261024_demo_chat_audit_truncate_guard", sql.includes(t.slice(t.indexOf('DROP TRIGGER IF EXISTS "demo_chat_audit_log_no_truncate"')).trim()));
  ok("custom objects come after the generated DDL (tables exist first)", sql.indexOf("-- ── 2. Custom SQL objects") > sql.lastIndexOf("-- AddForeignKey"));
}

// ── 4. Folders ────────────────────────────────────────────────────────────────
console.log("\n4. Active folder and archive");
{
  const active = readdirSync(path("prisma/migrations"));
  const dirs = active.filter((n) => statSync(path(`prisma/migrations/${n}`)).isDirectory());
  ok("active migrations folder: only the baseline directory", dirs.length === 1 && dirs[0] === BASELINE);
  ok("active folder files: migration_lock.toml + README.md only", active.filter((n) => !dirs.includes(n)).sort().join() === "README.md,migration_lock.toml");
  ok("baseline directory holds only migration.sql", readdirSync(path(`prisma/migrations/${BASELINE}`)).join() === "migration.sql");
  const arch = readdirSync(path("prisma/migrations_archive")).filter((n) => statSync(path(`prisma/migrations_archive/${n}`)).isDirectory());
  ok("archive holds exactly the 28 historical migrations", arch.length === 28 && Object.keys(ARCHIVE_SHA256).length === 28 && arch.every((n) => n in ARCHIVE_SHA256));
  const bad = Object.entries(ARCHIVE_SHA256).filter(([n, h]) => sha(`prisma/migrations_archive/${n}/migration.sql`) !== h);
  ok(`all 28 archived migration.sql files byte-identical (sha256)${bad.length ? ` — changed: ${bad.map(([n]) => n).join(", ")}` : ""}`, bad.length === 0);
  ok("each archived directory holds only migration.sql", arch.every((n) => readdirSync(path(`prisma/migrations_archive/${n}`)).join() === "migration.sql"));
  ok("baseline sorts after every archived migration", arch.every((n) => n < BASELINE));
  ok("Prisma config still points at prisma/migrations (archive not active)", /path:\s*"prisma\/migrations"/.test(read("prisma.config.ts")));
}

// ── 5. Documentation ──────────────────────────────────────────────────────────
console.log("\n5. Documentation");
{
  const r = read("prisma/migrations/README.md");
  ok("README: fresh database → prisma migrate deploy", /Fresh \(empty\) database/.test(r) && /npx prisma migrate deploy/.test(r));
  ok("README: existing database → resolve --applied, after an approved read-only comparison", r.includes(`npx prisma migrate resolve --applied ${BASELINE}`) && /READ-ONLY comparison/.test(r) && /_prisma_migrations/.test(r));
  ok("README: explains why the old migrations are archived", /24 schema tables are created by no migration/.test(r) && /Ordering defects/.test(r));
  ok("README: lists the custom objects and the guard", /Custom SQL objects/.test(r) && /Guarded baseline/.test(r) && /demo_chat_audit_log_no_truncate/.test(r));
  ok("README: rule to review partial / expression indexes in future migrations", /partial \/ expression indexes/.test(r) && /review the SQL/i.test(r));
  ok("README: does not claim any database was baselined", /No database — Production included — has been baselined/.test(r));
  ok("archive README: historical, not applied by Prisma", /Prisma does not read this folder and never\s+applies these files/.test(read("prisma/migrations_archive/README.md")));
  for (const d of ["docs/UGC_MODULE.md", "docs/FAKE_ORDERS_ENGINE.md", "docs/DEMO_CHAT.md"]) {
    const s = read(d);
    ok(`${d}: points at the baseline, both procedures, no baselining claimed`, s.includes(BASELINE) && /migrations_archive/.test(s) && /resolve --applied/.test(s) && /(No|no) database has been baselined/.test(s));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
