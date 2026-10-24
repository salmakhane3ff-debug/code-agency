#!/usr/bin/env node
/**
 * scripts/feedbackDate.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The admin-editable review DISPLAY date.
 *
 *   displayDate = reviewDate ?? createdAt
 *
 * Covers the pure helpers, the full persistence chain (admin form → controller →
 * service → Prisma column → public select → card) and, most importantly, the
 * BACKWARD-COMPATIBILITY guarantee: a feedback row written before this column
 * existed (reviewDate = NULL) must render exactly as it did before.
 *
 * Run: node scripts/feedbackDate.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import {
  resolveReviewDate, hasCustomReviewDate, relativeParts, monthsBetween,
  relativeDateLabel, absoluteDateLabel, parseAdminReviewDate, toDatetimeLocalValue,
} from "../src/lib/feedbackDate.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

const HELPER  = readFileSync("src/lib/feedbackDate.js", "utf8");
const ADMIN   = readFileSync("src/app/admin/feedback/page.jsx", "utf8");
const SERVICE = readFileSync("src/lib/services/feedbackService.js", "utf8");
const CTRL    = readFileSync("src/lib/controllers/feedbackController.js", "utf8");
const SCHEMA  = readFileSync("prisma/schema.prisma", "utf8");
const MIG     = readFileSync("prisma/migrations_archive/20260806_feedback_review_date/migration.sql", "utf8");
const CARD    = readFileSync("src/components/FeedbackCarousel.jsx", "utf8");

const NOW = new Date("2026-08-18T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000);

console.log("1) displayDate = reviewDate ?? createdAt:");
{
  const created = "2026-01-05T10:00:00.000Z";
  const custom  = "2025-03-09T08:30:00.000Z";
  ok("the admin override wins when set",
    resolveReviewDate({ createdAt: created, reviewDate: custom }).toISOString() === custom);
  ok("falls back to createdAt when reviewDate is null",
    resolveReviewDate({ createdAt: created, reviewDate: null }).toISOString() === created);
  ok("falls back to createdAt when the key is ABSENT (legacy row)",
    resolveReviewDate({ createdAt: created }).toISOString() === created);
  ok("accepts a real Date instance",
    resolveReviewDate({ reviewDate: new Date(custom) }).toISOString() === custom);
  ok("null when nothing usable exists", resolveReviewDate({}) === null);
  ok("null on an unparseable value", resolveReviewDate({ reviewDate: "not-a-date" }) === null);
  ok("null-safe on undefined input", resolveReviewDate(undefined) === null);
  ok("hasCustomReviewDate is true only for a real override",
    hasCustomReviewDate({ reviewDate: custom }) === true &&
    hasCustomReviewDate({ createdAt: created }) === false &&
    hasCustomReviewDate({ reviewDate: "junk" }) === false);
}

console.log("2) BACKWARD COMPATIBILITY — pre-migration rows are untouched:");
{
  // Exactly the shape the API returned before the column existed.
  const legacy = { _id: "old", authorName: "Souad", createdAt: "2026-06-18T12:00:00.000Z", rating: 5 };
  ok("a legacy row still resolves a date", resolveReviewDate(legacy) !== null);
  ok("it resolves to createdAt, unchanged",
    resolveReviewDate(legacy).toISOString() === legacy.createdAt);
  ok("legacy and null-reviewDate rows agree exactly",
    resolveReviewDate(legacy).getTime() ===
    resolveReviewDate({ ...legacy, reviewDate: null }).getTime());
  ok("a legacy row still produces a label",
    relativeDateLabel(resolveReviewDate(legacy), { locale: "ar", now: NOW }).length > 0);
  ok("the migration is ADDITIVE (ADD COLUMN only)", /ADD COLUMN/i.test(MIG));
  ok("the migration is idempotent (IF NOT EXISTS)", /IF NOT EXISTS/i.test(MIG));
  // Comments explain what the migration deliberately does NOT do, so scan SQL only.
  const SQL = MIG.replace(/--.*/g, "");
  ok("the migration never DROPs / renames / alters an existing column",
    !/DROP|RENAME|ALTER COLUMN/i.test(SQL));
  ok("the column is NULLABLE (no NOT NULL, no default backfill)",
    !/NOT NULL/i.test(SQL) && !/DEFAULT/i.test(SQL));
  ok("only the feedbacks table is touched",
    (MIG.match(/ALTER TABLE/gi) || []).length === 1 && /"feedbacks"/.test(MIG));
  ok("the Prisma field is optional", /reviewDate\s+DateTime\?/.test(SCHEMA));
  ok("createdAt is NOT redefined by this change",
    /createdAt\s+DateTime\s+@default\(now\(\)\)/.test(SCHEMA));
}

console.log("3) RELATIVE LABELS come from Intl, never hardcoded strings:");
{
  // Strip block AND line comments: only executable code may be scanned.
  const body = HELPER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  ok("no hardcoded relative-time words in the helper body", !/[؀-ۿ]/.test(body));
  ok("Intl.RelativeTimeFormat is the source of the label", /Intl\.RelativeTimeFormat/.test(body));
  ok("numeric:'auto' so idiomatic forms appear (\"last year\")", /numeric:\s*'auto'/.test(body));

  const ar = relativeDateLabel(daysAgo(61), { locale: "ar", now: NOW });
  const fr = relativeDateLabel(daysAgo(61), { locale: "fr", now: NOW });
  const en = relativeDateLabel(daysAgo(61), { locale: "en", now: NOW });
  ok("ar 2 months -> " + ar, /[؀-ۿ]/.test(ar));
  ok("fr 2 months -> " + fr, /mois/.test(fr));
  ok("en 2 months -> " + en, /month/.test(en));
  ok("the label really is locale-dependent (nothing hardcoded)", ar !== en && fr !== en);

  ok("a 400-day-old review reads in YEARS", relativeParts(daysAgo(400), NOW).unit === "year");
  ok("a 61-day-old review reads in MONTHS", relativeParts(daysAgo(61), NOW).unit === "month");
  ok("a 5-day-old review reads in DAYS", relativeParts(daysAgo(5), NOW).unit === "day");
  ok("a 3-hour-old review reads in HOURS",
    relativeParts(new Date(NOW.getTime() - 3 * 3_600_000), NOW).unit === "hour");
  ok("a 2-minute-old review reads in MINUTES",
    relativeParts(new Date(NOW.getTime() - 120_000), NOW).unit === "minute");
  ok("past dates are negative (\"ago\"), never future",
    relativeParts(daysAgo(61), NOW).value < 0 && relativeParts(daysAgo(5), NOW).value < 0);
  ok("monthsBetween counts calendar months",
    monthsBetween(new Date("2026-01-15T00:00:00"), new Date("2026-04-15T00:00:00")) === 3);
  ok("relativeDateLabel never throws on junk", relativeDateLabel("junk") === "");
  ok("absoluteDateLabel is the documented fallback", absoluteDateLabel(daysAgo(400), "en").length > 0);
  ok("absoluteAfterDays switches to an absolute date",
    relativeDateLabel(daysAgo(900), { locale: "en", now: NOW, absoluteAfterDays: 365 }) ===
    absoluteDateLabel(daysAgo(900), "en"));
}

console.log("4) ADMIN INPUT normalisation — unchanged dates stay unchanged:");
{
  ok("a cleared field sends null (restores the createdAt fallback)",
    parseAdminReviewDate("") === null && parseAdminReviewDate("   ") === null &&
    parseAdminReviewDate(null) === null);
  ok("an UNPARSEABLE value returns undefined so the key is dropped from the JSON",
    parseAdminReviewDate("hello") === undefined);
  ok("undefined survives JSON.stringify as an OMITTED key (stored date untouched)",
    !("reviewDate" in JSON.parse(JSON.stringify({ reviewDate: parseAdminReviewDate("hello"), rating: 5 }))));
  ok("null DOES survive JSON.stringify (an explicit clear reaches the DB)",
    JSON.parse(JSON.stringify({ reviewDate: parseAdminReviewDate("") })).reviewDate === null);
  ok("a datetime-local value becomes an ISO string",
    /^\d{4}-\d{2}-\d{2}T.*Z$/.test(parseAdminReviewDate("2025-03-09T08:30")));

  // Round-trip: prefill the form, submit it untouched, the stored instant is the
  // same (datetime-local has minute precision, so seconds are the only loss).
  const stored = new Date("2025-03-09T08:30:00");
  const prefilled = toDatetimeLocalValue(stored);
  const resent = parseAdminReviewDate(prefilled);
  ok("prefill -> submit unchanged is a lossless round-trip",
    new Date(resent).getTime() === stored.getTime());
  ok("toDatetimeLocalValue matches the input format",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(prefilled));
  ok("toDatetimeLocalValue is empty for a null date", toDatetimeLocalValue(null) === "");
  ok("an untouched EXISTING date round-trips to the same displayed label",
    relativeDateLabel(new Date(resent), { locale: "en", now: NOW }) ===
    relativeDateLabel(stored, { locale: "en", now: NOW }));
}

console.log("5) PERSISTENCE CHAIN — the admin date reaches the database:");
{
  ok("admin form state carries reviewDate", /reviewDate:\s*""/.test(ADMIN));
  ok("edit PREFILLS from the current display date",
    /reviewDate:\s*toDatetimeLocalValue\(resolveReviewDate\(item\)\)/.test(ADMIN));
  ok("a datetime-local input is rendered and bound to the form",
    /type="datetime-local"[\s\S]{0,240}form\.reviewDate/.test(ADMIN));
  ok("both save payloads normalise through parseAdminReviewDate",
    (ADMIN.match(/reviewDate:\s*parseAdminReviewDate\(form\.reviewDate\)/g) || []).length === 2);
  ok("the admin UI never fabricates a date client-side",
    !/new Date\(\)[\s\S]{0,40}reviewDate/.test(ADMIN));

  ok("the UPDATE path forwards its remaining fields straight to Prisma",
    /\.\.\.safe \} = data;/.test(SERVICE) && /data:\s+safe,/.test(SERVICE));
  ok("updateFeedback still STRIPS createdAt (the real creation date is never modified)",
    /createdAt: _createdAt/.test(SERVICE));
  ok("the CREATE path accepts reviewDate", /reviewDate\s+=\s+null,/.test(SERVICE));
  ok("the CREATE path only writes it when it parses",
    /if \(reviewDate\) \{[\s\S]{0,200}data\.reviewDate = d;/.test(SERVICE));
  ok("the controller forwards body.reviewDate on admin create",
    /reviewDate:\s*body\.reviewDate\s*\|\|\s*null/.test(CTRL));
  ok("the PUBLIC select ships reviewDate to the storefront", /reviewDate:\s*true/.test(SERVICE));
  ok("the public select still ships createdAt for the fallback", /createdAt:\s*true/.test(SERVICE));
  ok("ordering/moderation queries were NOT re-keyed onto the new column",
    /orderBy: \[\{ isFeatured: 'desc' \}, \{ createdAt: 'desc' \}\]/.test(SERVICE));
}

console.log("6) THE CARD renders the resolved date, not createdAt directly:");
{
  ok("the card resolves through the shared helper", /const date = resolveReviewDate\(item\)/.test(CARD));
  ok("the card labels it through relativeDateLabel", /relativeDateLabel\(date, \{ locale \}\)/.test(CARD));
  ok("the locale comes from the site's LanguageContext, not a literal",
    /const \{ t, lang, dir \} = useLanguage\(\)/.test(CARD) && /const locale = lang \|\| "ar"/.test(CARD));
  ok("the date is machine-readable <time dateTime>",
    /<time[\s\S]{0,160}dateTime=\{date \? date\.toISOString\(\) : undefined\}/.test(CARD));
  ok("a missing date renders nothing rather than 'Invalid Date'", /\{dateLabel && \(/.test(CARD));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
