#!/usr/bin/env node
/**
 * scripts/affiliateServerText.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Display-time localization of affiliate SERVER text (src/lib/serverText/affiliateServerText.js):
 *   1. every inventoried server error message (routes, services, auth middleware, rate limiter)
 *      is recognised and rendered in Arabic (MA) and French (FR); French text stays as sent
 *      for a French visitor, English (UGC) text gets a French translation;
 *   2. drift guard: the server files are scanned and EVERY error literal they can send to the
 *      affiliate pages must be in the table (or allowlisted with a reason); every pinned
 *      literal must still exist in its source;
 *   3. templates with variables, round-tripped through the REAL server code where it can run
 *      in node without a database (rate limiter, UGC upload/validation, deposit, identity and
 *      payout services with fake dbs), pinned literal + source check otherwise;
 *   4. every error CODE × ar/fr; Brand / Rewards codes covered by their own dictionaries;
 *   5. every AffiliateNotification.message template × ar/fr, round-tripped through the real
 *      builders (syncLinkedAffiliateOrderStatus, adminApproveDeposit, adminRejectDeposit,
 *      ugcNotifications.affiliateMessage, brandNotifications.notifyBrand) and a pinned literal
 *      for recordAffiliateOrder (global prisma, not injectable);
 *   6. unknown / admin-written / already-Arabic text unchanged;
 *   7. wiring: every page that shows server text or notifications goes through the localizer.
 * Run: node scripts/affiliateServerText.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import {
  SERVER_MESSAGES, SERVER_TEMPLATES, SERVER_CODES, SERVER_TEXT_CURRENCY, NOTIFICATION_TEMPLATES,
  ORDER_NOTIFICATION_LABELS, knownServerError, localizeServerError, localizeNotification, notificationTemplateOf,
} from "../src/lib/serverText/affiliateServerText.js";
import { BRAND_TEXT } from "../src/lib/brandI18n.js";
import { REWARDS_TEXT } from "../src/lib/rewardsI18n.js";
import { rateLimitStoreKey } from "../src/lib/rateLimit.js";
import { extractUploadedVideo } from "../src/lib/ugcUpload.js";
import { checkVideoPolicy, extractMp4Metadata } from "../src/lib/ugcVideoValidation.js";
import { ugcErrorResponse } from "../src/lib/ugcHttp.js";
import { affiliateMessage, UGC_NOTIFY_EVENT } from "../src/lib/ugcNotifications.js";
import { notifyBrand, BRAND_NOTIFICATION_TYPES } from "../src/lib/brandNotifications.js";
import { submitDeposit, adminApproveDeposit, adminRejectDeposit } from "../src/lib/services/depositService.js";
import { submitIdentity } from "../src/lib/services/identityService.js";
import { requestPayout, syncLinkedAffiliateOrderStatus } from "../src/lib/services/affiliateSystemService.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS ", name); }
  else { fail++; console.log("  FAIL ", name, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ""); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const AR = /[؀-ۿ]/;
const LRI = "⁦", FSI = "⁨", PDI = "⁩";
const iso = (v) => `${FSI}${v}${PDI}`;
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
// Silence the expected warnings of the real services (rewards hook deferral, ops logs).
const quiet = async (fn) => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

// ── 1. Inventory: every fixed server message × ar / fr, pinned in its source ──
console.log("\n1. Fixed server messages (inventory) × ar / fr");
const INVENTORY = {
  "src/lib/middleware/withAffiliateAuth.js": ["Token requis", "Token invalide", "Token expiré ou invalide", "Service indisponible"],
  "src/lib/rateLimit.js": ["Too many requests. Please try again later."],
  "src/lib/ugcHttp.js": ["Server error"],
  "src/app/api/affiliate/auth/route.js": ["Identifiant et mot de passe requis", "Trop de tentatives. Réessayez plus tard.", "Erreur serveur"],
  "src/lib/services/affiliateSystemService.js": [
    "Identifiant ou mot de passe incorrect", "Compte inactif. Contactez l\\'administrateur.", "Trop de tentatives. Réessayez plus tard.",
    "Montant invalide", "Veuillez ajouter vos coordonnées bancaires avant de demander un retrait.",
    "Votre identité doit être vérifiée avant de pouvoir effectuer un retrait.", "Montant supérieur aux gains disponibles",
    "Affilié introuvable", "Bonus déjà réclamé",
  ],
  "src/app/api/affiliate/me/route.js": ["Affilié introuvable", "Trop de tentatives. Réessayez plus tard.", "Mot de passe actuel requis", "Mot de passe actuel incorrect", "Erreur serveur"],
  "src/app/api/affiliate/avatar/route.js": ["Aucun fichier fourni", "Seules les images sont acceptées", "Image trop lourde (max 2 Mo)", "Erreur serveur"],
  "src/app/api/affiliate/identity/route.js": ["Les deux faces de la CIN sont requises.", "Chaque image doit faire au maximum 5 Mo.", "Erreur serveur"],
  "src/lib/services/identityService.js": ["Les deux faces de la CIN sont requises.", "Votre identité est déjà vérifiée.", "Une vérification est déjà en cours.", "Fichier invalide (type JPG/PNG/WEBP, max 5 Mo)."],
  "src/lib/identityStorage.js": ["Fichier image invalide"],
  "src/app/api/affiliate/payout/route.js": ["Montant invalide", "Erreur serveur"],
  "src/app/api/affiliate/boosters/route.js": ["Erreur serveur"],
  "src/lib/services/boosterService.js": ["Méthode de paiement invalide", "Les boosters sont désactivés pour le moment", "Pack introuvable ou inactif", "Vous avez déjà ce pack (actif ou en attente)", "Solde insuffisant"],
  "src/app/api/affiliate/deposits/route.js": ["La preuve du virement est requise.", "Fichier trop volumineux (max 8 Mo).", "Erreur serveur"],
  "src/lib/services/depositService.js": ["Vous avez déjà une demande en attente de validation.", "Montant invalide.", "Méthode de paiement requise.", "La preuve du virement est requise.", "Fichier invalide (JPG/PNG/WEBP/PDF, max 8 Mo)."],
  "src/lib/services/ugcService.js": [
    "affiliate identity required", "UGC uploads are currently disabled", "productId required", "advertising consent is required",
    "product not found", "product is not active", "a submission already exists for this product — replace it instead",
    "a submission already exists for this product", "invalid video", "submission not found", "not your submission",
    "submission changed concurrently", "submission status changed concurrently",
  ],
  "src/lib/ugcRouteHandlers.js": ["unknown action"],
  "src/lib/ugcUpload.js": ["a video file is required", "the uploaded file is not a video", "the video file is empty"],
  "src/lib/ugcVideoValidation.js": [
    "empty file", "unrecognized container — not a valid video file", "only MP4/MOV videos can be parsed by the JS validator",
    "corrupted or truncated video structure", "missing ftyp header", "corrupted video structure",
    "missing moov — incomplete video (e.g. still uploading)", "corrupted movie header", "missing movie header (mvhd)",
    "could not determine video duration", "corrupted sample description", "file exceeds maximum size", "unknown container", "no readable video codec",
  ],
  "src/lib/brandRouteHandlers.js": ["Erreur serveur", "Requête invalide"],
};
const ENGLISH = new Set(["Too many requests. Please try again later.", "Server error"]);
for (const f of ["src/lib/services/ugcService.js", "src/lib/ugcRouteHandlers.js", "src/lib/ugcUpload.js", "src/lib/ugcVideoValidation.js"]) INVENTORY[f].forEach((m) => ENGLISH.add(m));
const unescape = (s) => s.replace(/\\'/g, "'");
const inventoried = new Set();
for (const [file, msgs] of Object.entries(INVENTORY)) {
  const src = read(file);
  const missing = msgs.filter((m) => !src.includes(`'${m}'`));
  ok(`${file}: every pinned message still in the source (${msgs.length})`, missing.length === 0, missing);
  msgs.forEach((m) => inventoried.add(unescape(m)));
}
const badAr = [], badFr = [];
for (const m of inventoried) {
  const ar = localizeServerError(m, "ar"), fr = localizeServerError(m, "fr");
  if (!(AR.test(ar) && ar !== m)) badAr.push([m, ar]);
  if (ENGLISH.has(m) ? !(fr && fr !== m && !AR.test(fr)) : fr !== m) badFr.push([m, fr]);
}
ok(`all ${inventoried.size} inventoried messages → Arabic for MA`, badAr.length === 0, badAr);
ok("French server text unchanged for FR; English (UGC / limiter) text translated to French", badFr.length === 0, badFr);
ok("the table holds no message outside the inventory (no dead entries)", Object.keys(SERVER_MESSAGES).every((m) => inventoried.has(m)),
  Object.keys(SERVER_MESSAGES).filter((m) => !inventoried.has(m)));
ok("table values: ar Arabic, fr French / non-Arabic, both non-empty", Object.values(SERVER_MESSAGES).every((v) => AR.test(v.ar) && v.fr && !AR.test(v.fr)));
ok("trailing spaces of a known message are tolerated", localizeServerError(" Erreur serveur ", "ar") === "خطأ في الخادم");
ok("exact wording pinned (samples)",
  localizeServerError("Erreur serveur", "ar") === "خطأ في الخادم"
  && localizeServerError("Identifiant ou mot de passe incorrect", "ar") === "اسم المستخدم أو كلمة المرور غير صحيحة"
  && localizeServerError("Solde insuffisant", "ar") === "رصيد غير كافٍ"
  && localizeServerError("product not found", "fr") === "Produit introuvable."
  && localizeServerError("Too many requests. Please try again later.", "fr") === "Trop de requêtes. Veuillez réessayer plus tard.");

// ── 2. Drift guard: every error literal the files can send must be known ──────
console.log("\n2. Drift guard (source scan)");
// Literals that never reach the affiliate pages listed here (with the reason).
const NOT_SHOWN = new Set([
  "Affilié requis", "id requis", "Statut non autorisé", "Commande introuvable", "Cette commande ne peut plus être modifiée", // PUT /orders: the page maps the HTTP status (affiliateOrderMessages)
  "username et password sont requis", "Affilié parent introuvable", // admin affiliate creation
  "Action invalide", "Achat introuvable ou déjà traité", // admin booster review
  "Le motif de refus est requis.", // admin deposit / identity review
  "a rejection reason is required", // admin UGC review
]);
const SCAN = [
  "src/lib/middleware/withAffiliateAuth.js", "src/lib/rateLimit.js", "src/lib/ugcHttp.js", "src/lib/ugcRouteHandlers.js", "src/lib/ugcUpload.js",
  "src/lib/ugcVideoValidation.js", "src/lib/services/ugcService.js", "src/lib/services/affiliateSystemService.js", "src/lib/services/boosterService.js",
  "src/lib/services/depositService.js", "src/lib/services/identityService.js", "src/lib/identityStorage.js",
  ...["auth", "avatar", "boosters", "claim-bonus", "deposits", "identity", "me", "payout"].map((r) => `src/app/api/affiliate/${r}/route.js`),
];
const LITERAL = [
  /[{,]\s*error:\s*'((?:[^'\\]|\\.)*)'/g, /new Error\('((?:[^'\\]|\\.)*)'\)/g, /\berr\(\s*'[A-Z_]+',\s*'((?:[^'\\]|\\.)*)'/g,
  /\bfail\('((?:[^'\\]|\\.)*)'\)/g, /return \{ error: '((?:[^'\\]|\\.)*)' \}/g, /JSON\.stringify\(\{ error: '((?:[^'\\]|\\.)*)' \}\)/g,
];
// Template literals (backticks) the pages can show — each one is a SERVER_TEMPLATES entry (§3).
const TEMPLATE_SOURCES = [
  "`Le mot de passe doit contenir entre ${PASSWORD_MIN} et ${PASSWORD_MAX} caractères`",
  "`Objectif non atteint : ${validReferrals} / ${config.requiredActiveAffiliates} parrainages valides`",
  "`cannot replace a submission in status ${sub.status}`",
  "`${actorType} may not set status ${toStatus}`",
  "`upload exceeds the ${maxBytes}-byte limit`",
  "`the video exceeds the ${maxBytes}-byte limit`",
  "`unsupported container: ${meta.container}`",
  "`video too short: ${dur.toFixed(1)}s (min ${minSeconds}s)`",
  "`video too long: ${dur.toFixed(1)}s (max ${maxSeconds}s)`",
  "`unsupported video codec: ${codecs.join(', ')}`",
];
const unknownLiterals = [], unknownTemplates = [];
for (const file of SCAN) {
  const src = read(file).replace(/^\s*(\/\/|\*).*$/gm, "");
  for (const re of LITERAL) for (const m of src.matchAll(re)) {
    const msg = unescape(m[1]);
    if (!NOT_SHOWN.has(msg) && knownServerError(msg, "ar") === null) unknownLiterals.push(`${file}: ${msg}`);
  }
  for (const m of src.matchAll(/(?:[{,]\s*error:\s*|new Error\(|\berr\(\s*'[A-Z_]+',\s*|\bfail\()(`[^`]*`)/g)) {
    if (!TEMPLATE_SOURCES.includes(m[1])) unknownTemplates.push(`${file}: ${m[1]}`);
  }
}
ok(`every error literal the affiliate pages can receive is localized (${SCAN.length} files scanned)`, unknownLiterals.length === 0, unknownLiterals);
ok("every error template literal is a known template", unknownTemplates.length === 0, unknownTemplates);
const allSrc = SCAN.map(read).join("\n");
ok("every pinned template literal still exists in the server code", TEMPLATE_SOURCES.every((s) => allSrc.includes(s)), TEMPLATE_SOURCES.filter((s) => !allSrc.includes(s)));
ok("claim-bonus / boosters / deposits / identity / payout routes forward the service message (err.message)",
  ["claim-bonus", "boosters", "deposits", "identity", "payout"].every((r) => /error: err\.message/.test(read(`src/app/api/affiliate/${r}/route.js`))));

// ── 3. Templates with variables — real code round-trips ───────────────────────
console.log("\n3. Server templates (real code where it runs without a database)");
const rt = (name, server, ar, fr) => ok(`${name}: ar / fr`, localizeServerError(server, "ar") === ar && localizeServerError(server, "fr") === fr,
  { server, ar: localizeServerError(server, "ar"), fr: localizeServerError(server, "fr") });
{
  // Pinned (route-local constants, '@/' route imports node cannot load): PASSWORD_MIN 6, PASSWORD_MAX 128.
  const me = read("src/app/api/affiliate/me/route.js");
  ok("me route still uses PASSWORD_MIN = 6 / PASSWORD_MAX = 128", /const PASSWORD_MIN = 6;/.test(me) && /const PASSWORD_MAX = 128;/.test(me));
  rt("password length", "Le mot de passe doit contenir entre 6 et 128 caractères", "يجب أن تحتوي كلمة المرور على ما بين 6 و128 حرفاً", "Le mot de passe doit contenir entre 6 et 128 caractères");
  rt("team goal not met (pinned: claimTeamBonus uses the global prisma)", "Objectif non atteint : 2 / 5 parrainages valides",
    `لم يتم بلوغ الهدف: ${LRI}2 / 5${PDI} إحالات صالحة`, "Objectif non atteint : 2 / 5 parrainages valides");
  rt("UGC not replaceable", "cannot replace a submission in status RUNNING", `لا يمكن استبدال فيديو في الحالة ${iso("RUNNING")}.`, "Impossible de remplacer une vidéo au statut RUNNING.");
  rt("UGC illegal transition", "AFFILIATE may not set status APPROVED", `تغيير الحالة إلى ${iso("APPROVED")} غير مسموح به.`, "Passage au statut APPROVED non autorisé.");
}
{
  // Real shared limiter: the 3rd request in the window gets the limiter's own body.
  const key = `serverText-test-${Date.now()}`;
  rateLimitStoreKey(key, { max: 1 }); rateLimitStoreKey(key, { max: 1 });
  const r = rateLimitStoreKey(key, { max: 1 });
  const body = await r.json();
  rt("rate limiter (real)", body.error, "طلبات كثيرة جداً. يرجى المحاولة لاحقاً.", "Trop de requêtes. Veuillez réessayer plus tard.");
}
{
  // Real UGC upload guard (ugcUpload.extractUploadedVideo) with fake requests.
  const reqOf = (file, cl) => ({ headers: { get: (h) => (h === "content-length" ? cl : null) }, formData: async () => ({ get: () => file }) });
  const e1 = await codeOf(() => extractUploadedVideo(reqOf(null), { maxBytes: 100 }));
  rt("upload: no file (real)", e1.message, "ملف الفيديو مطلوب.", "Un fichier vidéo est requis.");
  const e2 = await codeOf(() => extractUploadedVideo(reqOf({ type: "image/png", size: 5, arrayBuffer: async () => new ArrayBuffer(5) }), { maxBytes: 100 }));
  rt("upload: not a video (real)", e2.message, "الملف المرسل ليس فيديو.", "Le fichier envoyé n'est pas une vidéo.");
  const e3 = await codeOf(() => extractUploadedVideo(reqOf({ type: "video/mp4", size: 0, arrayBuffer: async () => new ArrayBuffer(0) }), { maxBytes: 100 }));
  rt("upload: empty video (real)", e3.message, "ملف الفيديو فارغ.", "Le fichier vidéo est vide.");
  const e4 = await codeOf(() => extractUploadedVideo(reqOf({ type: "video/mp4", size: 500, arrayBuffer: async () => new ArrayBuffer(500) }), { maxBytes: 100 }));
  rt("upload: video over the limit (real)", e4.message, "الفيديو يتجاوز الحجم الأقصى (100 بايت).", "La vidéo dépasse la taille maximale (100 octets).");
  const e5 = await codeOf(() => extractUploadedVideo(reqOf(null, "999"), { maxBytes: 100 }));
  rt("upload: content-length over the limit (real)", e5.message, "الفيديو يتجاوز الحجم الأقصى (100 بايت).", "La vidéo dépasse la taille maximale (100 octets).");
}
{
  // Real video validation (ugcVideoValidation): metadata errors + policy templates.
  rt("validation: empty file (real)", extractMp4Metadata(Buffer.alloc(0)).error, "ملف فارغ.", "Fichier vide.");
  rt("validation: not a video (real)", extractMp4Metadata(Buffer.from("hello world, definitely not a video")).error,
    "صيغة غير معروفة: هذا ليس ملف فيديو صالحاً.", "Format non reconnu : ce n'est pas une vidéo valide.");
  const pol = (meta, bytes, opts) => checkVideoPolicy(meta, bytes, opts).reason;
  rt("policy: too big (real)", pol({ container: "mp4", durationSeconds: 5, codecs: ["avc1"] }, 10, { maxBytes: 5 }), "الملف يتجاوز الحجم الأقصى.", "Le fichier dépasse la taille maximale.");
  rt("policy: unknown container (real)", pol({}, 1), "صيغة فيديو غير معروفة.", "Format vidéo inconnu.");
  rt("policy: unsupported container (real)", pol({ container: "webm", durationSeconds: 5 }, 1), `صيغة الفيديو غير مدعومة: ${iso("webm")}`, "Format vidéo non pris en charge : webm");
  rt("policy: no duration (real)", pol({ container: "mp4" }, 1), "تعذّر تحديد مدة الفيديو.", "Impossible de déterminer la durée de la vidéo.");
  rt("policy: too short (real)", pol({ container: "mp4", durationSeconds: 1.24, codecs: ["avc1"] }, 1, { minSeconds: 3 }),
    "الفيديو قصير جداً: 1.2 ث (الحد الأدنى 3 ث)", "Vidéo trop courte : 1.2 s (minimum 3 s)");
  rt("policy: too long (real)", pol({ container: "mp4", durationSeconds: 700, codecs: ["avc1"] }, 1, { maxSeconds: 600 }),
    "الفيديو طويل جداً: 700.0 ث (الحد الأقصى 600 ث)", "Vidéo trop longue : 700.0 s (maximum 600 s)");
  rt("policy: unsupported codec (real)", pol({ container: "mp4", durationSeconds: 5, codecs: ["xyz1", "mp4a"] }, 1),
    `ترميز الفيديو غير مدعوم: ${iso("xyz1, mp4a")}`, "Codec vidéo non pris en charge : xyz1, mp4a");
  rt("policy: no codec (real)", pol({ container: "mp4", durationSeconds: 5, codecs: [] }, 1), "لا يوجد ترميز فيديو قابل للقراءة.", "Aucun codec vidéo lisible.");
  const r500 = await quiet(() => ugcErrorResponse(new Error("boom")).json());
  ok("UGC 500 body (real ugcErrorResponse): the raw error message is unknown → shown unchanged, its code UGC_ERROR known",
    localizeServerError(r500.error, "ar") === "boom" && localizeServerError({ code: r500.code }, "ar") === "خطأ في الخادم");
  const r409 = await ugcErrorResponse(Object.assign(new Error("a submission already exists for this product"), { code: "UGC_ALREADY_SUBMITTED" })).json();
  ok("UGC coded body (real ugcErrorResponse) → ar / fr", localizeServerError(r409, "ar") === "يوجد فيديو لهذا المنتج بالفعل." && localizeServerError(r409, "fr") === "Une vidéo existe déjà pour ce produit.");
}
{
  // Real deposit / identity / payout services with fake dbs (the exact messages the routes forward).
  const depDb = (pending) => ({ affiliateSecurityDeposit: { findFirst: async () => (pending ? { id: "p" } : null) }, setting: { findUnique: async () => ({ value: { depositAmount: 100 } }) }, settings: { findFirst: async () => null } });
  const ePending = await codeOf(() => submitDeposit("a", { paymentMethod: "x" }, depDb(true), { process: async () => "k", remove: async () => {} }));
  rt("deposit: pending exists (real submitDeposit)", ePending.message, "لديك بالفعل طلب في انتظار التحقق.", "Vous avez déjà une demande en attente de validation.");
  const idDb = (status) => ({ identityVerification: { findUnique: async () => (status ? { status } : null) } });
  const eBoth = await codeOf(() => submitIdentity("a", { front: null, back: null }, idDb(null)));
  rt("identity: both sides (real submitIdentity)", eBoth.message, "وجها البطاقة الوطنية مطلوبان.", "Les deux faces de la CIN sont requises.");
  const f = { mime: "image/jpeg", size: 10, buffer: Buffer.alloc(10) };
  const eApproved = await codeOf(() => submitIdentity("a", { front: f, back: f }, idDb("APPROVED")));
  rt("identity: already approved (real)", eApproved.message, "تم التحقق من هويتك مسبقاً.", "Votre identité est déjà vérifiée.");
  const ePend = await codeOf(() => submitIdentity("a", { front: f, back: f }, idDb("PENDING")));
  rt("identity: already pending (real)", ePend.message, "هناك طلب تحقق قيد المراجعة بالفعل.", "Une vérification est déjà en cours.");
  const bad = { mime: "application/zip", size: 10, buffer: Buffer.alloc(10) };
  const eFile = await codeOf(() => submitIdentity("a", { front: bad, back: f }, idDb(null)));
  rt("identity: invalid file (real)", eFile.message, "ملف غير صالح (JPG أو PNG أو WEBP، 5 ميغابايت كحد أقصى).", "Fichier invalide (type JPG/PNG/WEBP, max 5 Mo).");
  const payDb = (bank, idv) => ({ affiliate: { findUnique: async () => bank }, identityVerification: { findUnique: async () => idv } });
  const eAmount = await codeOf(() => requestPayout("a", "abc", payDb(null, null)));
  rt("payout: invalid amount (real requestPayout)", eAmount.message, "مبلغ غير صالح", "Montant invalide");
  const eBank = await codeOf(() => requestPayout("a", 10, payDb({ bankName: "", accountName: "", rib: "" }, null)));
  rt("payout: bank details missing (real)", eBank.message, "يرجى إضافة معلوماتك البنكية قبل طلب السحب.", "Veuillez ajouter vos coordonnées bancaires avant de demander un retrait.");
  const eIdv = await codeOf(() => requestPayout("a", 10, payDb({ bankName: "CIH", accountName: "Ali", rib: "123456789012345678901234" }, { status: "PENDING" })));
  rt("payout: identity not verified (real)", eIdv.message, "يجب التحقق من هويتك قبل أن تتمكن من السحب.", "Votre identité doit être vérifiée avant de pouvoir effectuer un retrait.");
}
ok(`every template is exercised above (${SERVER_TEMPLATES.length})`, SERVER_TEMPLATES.length === 9);

// ── 4. Error codes ────────────────────────────────────────────────────────────
console.log("\n4. Error codes × ar / fr");
ok(`every code (${Object.keys(SERVER_CODES).length}): ar Arabic, fr French`, Object.entries(SERVER_CODES).every(([, v]) => AR.test(v.ar) && v.fr && !AR.test(v.fr)));
ok("a code alone is localized", localizeServerError("UGC_DISABLED", "ar") === "رفع فيديوهات UGC متوقف حالياً." && localizeServerError("SERVER_ERROR", "fr") === "Erreur serveur");
ok("message wins over code; unknown message falls back to its code",
  localizeServerError({ error: "Solde insuffisant", code: "INSUFFICIENT_BALANCE" }, "ar") === "رصيد غير كافٍ"
  && localizeServerError({ error: "video codec exploded", code: "UGC_INVALID_VIDEO" }, "ar") === "فيديو غير صالح."
  && localizeServerError({ text: "Montant supérieur aux gains disponibles", code: "INSUFFICIENT_BALANCE" }, "ar") === "المبلغ أكبر من الأرباح المتاحة");
ok("route-dependent codes are NOT in the code table (their message decides)",
  ["INVALID_INPUT", "NOT_FOUND", "INSUFFICIENT_BALANCE", "PACKAGE_NOT_FOUND", "INVALID_AMOUNT", "NOT_PENDING"].every((c) => !(c in SERVER_CODES)));
{
  // Codes the routes attach: every one must be known (here or in the area's own dictionary).
  const routeCodes = new Set();
  for (const r of ["auth", "boosters", "deposits", "identity", "payout"]) {
    const src = read(`src/app/api/affiliate/${r}/route.js`);
    for (const m of src.matchAll(/'([A-Z][A-Z_]{3,})'/g)) routeCodes.add(m[1]);
  }
  for (const m of read("src/lib/ugcHttp.js").matchAll(/^\s+(UGC_[A-Z_]+):/gm)) routeCodes.add(m[1]);
  const ADMIN_OR_INPUT = new Set(["INVALID_CREDENTIALS", "INACTIVE", "LOGIN_THROTTLED", "UGC_BAD_ACTOR", "UGC_REASON_REQUIRED", "UGC_BAD_STATUS", "UGC_INVALID_SETTINGS",
    "INSUFFICIENT_BALANCE", "INVALID_AMOUNT", "PACKAGE_NOT_FOUND", "BALANCE", "CARD"]); // admin-only / internal / message-decided
  const missing = [...routeCodes].filter((c) => !ADMIN_OR_INPUT.has(c) && !(c in SERVER_CODES));
  ok(`every code the affiliate routes send is translated (${routeCodes.size} scanned)`, missing.length === 0, missing);
  // Brand: every affiliate-facing code (brandRouteHandlers STATUS) → brandI18n code_* or this table (SERVER_ERROR).
  const status = read("src/lib/brandRouteHandlers.js").match(/const STATUS = \{([\s\S]*?)\};/)[1];
  const brandAdmin = new Set(["PAYMENT_REFERENCE_REQUIRED", "REASON_REQUIRED", "INVALID_ACTION", "PACKAGE_REMOVED", "TERMS_EMPTY", "TERMS_UNCHANGED", "AFFILIATE_NOT_FOUND",
    "AUTHORIZATION_NOT_FOUND", "AUTHORIZATION_EXISTS", "NO_CLOSED_ACCESS", "NOT_REVOCABLE", "NOT_ACTIVE", "NOT_CLOSED", "PROOF_NOT_SUBMITTED"]);
  const brandCodes = [...status.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).filter((c) => !brandAdmin.has(c));
  ok(`Brand codes (${brandCodes.length}): brandI18n code_* in both languages`, brandCodes.every((c) => BRAND_TEXT.fr[`code_${c}`] && BRAND_TEXT.ar[`code_${c}`]));
  ok("Brand generic 500 (SERVER_ERROR + 'Erreur serveur') known here", /error: 'Erreur serveur', code: 'SERVER_ERROR'/.test(read("src/lib/brandRouteHandlers.js"))
    && knownServerError({ error: "Erreur serveur", code: "SERVER_ERROR" }, "ar") === "خطأ في الخادم");
  ok("Rewards generic 500 (SERVER_ERROR) + INVALID_JSON 'Requête invalide' known here; Rewards codes in rewardsI18n",
    /error: 'Erreur serveur', code: 'SERVER_ERROR'/.test(read("src/lib/rewardsHttp.js")) && /'Requête invalide'/.test(read("src/lib/rewardsHttp.js"))
    && knownServerError({ error: "Requête invalide", code: "INVALID_JSON" }, "ar") === "طلب غير صالح"
    && ["REWARDS_DISABLED", "AFFILIATE_INACTIVE", "INSUFFICIENT_POINTS", "RATE_LIMITED"].every((c) => REWARDS_TEXT.ar[`code_${c}`]));
  ok("activation / recovery pages: server CODES only, mapped to their dictionary keys (no server text shown)",
    /ERROR_TEXT\[c\] \?\? GENERIC/.test(read("src/app/affiliate/activate/page.jsx")) && /ERROR_TEXT\[code\] \|\| GENERIC/.test(read("src/app/affiliate/activate/recovery/page.jsx")));
}

// ── 5. Notifications: real builders → localize → expected ar / fr ─────────────
console.log("\n5. AffiliateNotification templates × ar / fr");
const nt = (name, stored, ar, fr) => ok(`${name}: ar / fr`, localizeNotification(stored, "ar") === ar && localizeNotification(stored, "fr") === fr,
  { stored, ar: localizeNotification(stored, "ar"), fr: localizeNotification(stored, "fr") });
const DH = SERVER_TEXT_CURRENCY.fr, DRH = SERVER_TEXT_CURRENCY.ar;
ok("currency labels: ar « درهم », fr « DH »", DRH === "درهم" && DH === "DH");
{
  // recordAffiliateOrder writes through the global prisma → pinned literal + exact source check.
  const sys = read("src/lib/services/affiliateSystemService.js");
  ok("recordAffiliateOrder template unchanged in the source",
    sys.includes("message:     `Nouvelle commande: ${Number(total).toFixed(0)} MAD - Client: ${clientName || 'Inconnu'}${isSuspicious ? ' ⚠' : ''}`,"));
  const build = (total, clientName, isSuspicious) => `Nouvelle commande: ${Number(total).toFixed(0)} MAD - Client: ${clientName || "Inconnu"}${isSuspicious ? " ⚠" : ""}`;
  nt("new order", build(249.6, "Ahmed Benali", false), `طلب جديد: 250 ${DRH} - العميل: ${iso("Ahmed Benali")}`, `Nouvelle commande: 250 ${DH} - Client: Ahmed Benali`);
  nt("new order, suspicious", build(99, "سعيد", true), `طلب جديد: 99 ${DRH} - العميل: ${iso("سعيد")} ⚠`, `Nouvelle commande: 99 ${DH} - Client: سعيد ⚠`);
  nt("new order, unknown client", build(0, "", false), `طلب جديد: 0 ${DRH} - العميل: ${iso("غير معروف")}`, `Nouvelle commande: 0 ${DH} - Client: Inconnu`);
}
{
  // syncLinkedAffiliateOrderStatus — REAL builder with a fake db (non-transaction db: the rewards hook defers).
  const statusOf = async (status, clientName, total = 180) => {
    const notes = [];
    const db = {
      affiliateOrder: { findFirst: async () => ({ id: "ao1", affiliateId: "a1", total, status: "pending", clientName }), update: async () => ({}) },
      affiliateNotification: { create: async ({ data }) => { notes.push(data.message); return data; } },
      affiliate: { findUnique: async () => null, update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    };
    await quiet(() => syncLinkedAffiliateOrderStatus("o1", status === "pending" ? "PENDING_X" : status, { db }).catch(() => {}));
    return notes[0];
  };
  const AR_PHRASE = { confirmed: "تم تأكيد الطلب", shipped: "تم شحن الطلب", delivered: "تم توصيل الطلب", cancelled: "تم إلغاء الطلب" };
  const FR_LABEL = { confirmed: "confirmée", shipped: "expédiée", delivered: "livrée", cancelled: "annulée" };
  for (const s of ["confirmed", "shipped", "delivered", "cancelled"]) {
    const stored = await statusOf(s, "Karim");
    nt(`order ${s} (real syncLinkedAffiliateOrderStatus)`, stored, `${AR_PHRASE[s]}: 180 ${DRH} - العميل: ${iso("Karim")}`, `Commande ${FR_LABEL[s]}: 180 ${DH} - Client: Karim`);
  }
  const unknownClient = await statusOf("confirmed", null);
  nt("order status, unknown client (real)", unknownClient, `تم تأكيد الطلب: 180 ${DRH} - العميل: ${iso("غير معروف")}`, `Commande confirmée: 180 ${DH} - Client: Inconnu`);
  const raw = await statusOf("returned", "Sara");
  nt("order status outside the label map (raw status kept as data, real)", raw, `الطلب ${iso("returned")}: 180 ${DRH} - العميل: ${iso("Sara")}`, `Commande returned: 180 ${DH} - Client: Sara`);
  // 'en attente' label: the builder maps 'pending'; an order cannot change to its own status, so pinned.
  ok("status label map pinned in the source (incl. pending → en attente)", read("src/lib/services/affiliateSystemService.js").includes("cancelled: 'annulée',   pending: 'en attente',"));
  nt("order pending (pinned)", "Commande en attente: 75 MAD - Client: Nadia", `الطلب قيد الانتظار: 75 ${DRH} - العميل: ${iso("Nadia")}`, `Commande en attente: 75 ${DH} - Client: Nadia`);
  ok("every builder label has an Arabic phrase", ["confirmée", "expédiée", "livrée", "annulée", "en attente"].every((l) => ORDER_NOTIFICATION_LABELS.includes(l)));
}
{
  // Deposit approve / reject — REAL builders with a fake db.
  const notes = [];
  const rows = { d1: { id: "d1", affiliateId: "a", amount: 500, status: "PENDING" }, d2: { id: "d2", affiliateId: "a", amount: 300, status: "PENDING" } };
  const db = {
    affiliateSecurityDeposit: {
      findUnique: async ({ where }) => rows[where.id] ?? null,
      updateMany: async ({ where, data }) => { const r = rows[where.id]; if (!r || r.status !== where.status) return { count: 0 }; Object.assign(r, data); return { count: 1 }; },
    },
    affiliateNotification: { create: async ({ data }) => { notes.push(data.message); return data; } },
  };
  await adminApproveDeposit("d1", "admin", db);
  nt("deposit approved (real adminApproveDeposit)", notes[0],
    `تمت الموافقة على شحن رصيدك بمبلغ 500 ${DRH} وأُضيف إلى رصيدك المتاح.`, `Votre dépôt de solde de 500 ${DH} a été approuvé et ajouté à votre solde disponible.`);
  await adminRejectDeposit("d2", "Preuve illisible, merci de renvoyer.", "admin", db);
  nt("deposit refused, admin reason kept as data (real adminRejectDeposit)", notes[1],
    `تم رفض طلب شحن الرصيد.\nالسبب:\n${iso("Preuve illisible, merci de renvoyer.")}`, "Votre dépôt de solde a été refusé.\nRaison :\nPreuve illisible, merci de renvoyer.");
}
{
  // UGC — REAL affiliateMessage for every event, with and without product title / reason.
  const E = UGC_NOTIFY_EVENT;
  const AR_BASE = {
    [E.SUBMISSION_RECEIVED]: "🎬 تم استلام الفيديو الخاص بك وسيراجعه فريقنا.",
    [E.APPROVED]: "✅ تمت الموافقة على الفيديو الخاص بك.",
    [E.RUNNING]: "▶️ الفيديو الخاص بك قيد النشر الآن ويمكنه تحقيق أرباح.",
    [E.PAUSED]: "⏸️ تم إيقاف الفيديو الخاص بك مؤقتاً: لم يعد يحقق أرباحاً.",
  };
  for (const ev of [E.SUBMISSION_RECEIVED, E.APPROVED, E.RUNNING, E.PAUSED]) {
    const plain = affiliateMessage(ev, {});
    nt(`UGC ${ev} (real)`, plain, AR_BASE[ev], plain);
    const titled = affiliateMessage(ev, { productTitle: "Montre (édition or)" });
    nt(`UGC ${ev} + product title (real)`, titled, `${AR_BASE[ev]} (${iso("Montre (édition or)")})`, titled);
  }
  const r1 = affiliateMessage(E.REJECTED, {});
  nt("UGC rejected (real)", r1, "❌ تم رفض الفيديو الخاص بك. يمكنك استبداله.", r1);
  const r2 = affiliateMessage(E.REJECTED, { reason: "Son inaudible", productTitle: "Sac cuir" });
  nt("UGC rejected + reason + title (real)", r2, `❌ تم رفض الفيديو الخاص بك. السبب: ${iso("Son inaudible")} يمكنك استبداله. (${iso("Sac cuir")})`, r2);
  const r3 = affiliateMessage(E.REJECTED, { reason: "صوت غير واضح" });
  nt("UGC rejected + Arabic admin reason kept as is (real)", r3, `❌ تم رفض الفيديو الخاص بك. السبب: ${iso("صوت غير واضح")} يمكنك استبداله.`, r3);
  ok("every UGC event has a template", Object.values(E).every((ev) => notificationTemplateOf(affiliateMessage(ev, { productTitle: "X" })) !== null));
}
{
  // Brand — REAL notifyBrand (fake transaction) for the six types.
  const notes = [];
  const tx = { affiliateNotification: { create: async ({ data }) => { notes.push(data.message); return data; } } };
  const send = async (type, vars) => { await notifyBrand(tx, { type, affiliateId: "a", auditId: `au-${type}`, ...vars }); return notes[notes.length - 1]; };
  const P = "أنشئ علامتك التجارية";
  const brand = "Atlas « Gold »";
  const exp = {
    submitted: [{ brandName: brand }, `${P}: تم استلام إثبات الدفع الخاص بـ « ${iso(brand)} ». سيتحقق منه الفريق.`],
    accepted: [{ brandName: brand }, `${P}: تم تأكيد دفعتك الخاصة بـ « ${iso(brand)} ». تم تفعيل وصولك إلى محاكي التدريب.`],
    rejected: [{ brandName: brand, reason: "Virement introuvable" }, `${P}: تم رفض طلبك « ${iso(brand)} ».\nالسبب:\n${iso("Virement introuvable")}`],
    closed: [{ brandName: brand, reason: "Fin de la formation\nMerci" }, `${P}: تم إغلاق علامتك التجارية « ${iso(brand)} ». يبقى سجلها متاحاً للاطلاع.\nالسبب:\n${iso("Fin de la formation\nMerci")}`],
    reopened: [{ brandName: brand }, `${P}: تمت إعادة فتح علامتك التجارية « ${iso(brand)} ». تُستأنف المحاكاة ابتداءً من الآن.`],
    authorized: [{}, `${P}: أصبح بإمكانك تقديم طلب علامة تجارية جديد.`],
  };
  ok("all six brand notification types covered", BRAND_NOTIFICATION_TYPES.every((tp) => tp in exp) && Object.keys(exp).length === BRAND_NOTIFICATION_TYPES.length);
  for (const type of BRAND_NOTIFICATION_TYPES) {
    const stored = await send(type, exp[type][0]);
    nt(`brand ${type} (real notifyBrand)`, stored, exp[type][1], stored);
  }
}
ok(`every notification template exercised (${NOTIFICATION_TEMPLATES.length})`, NOTIFICATION_TEMPLATES.length === 12);

// ── 6. Unknown / admin / Arabic text unchanged ────────────────────────────────
console.log("\n6. Unknown text unchanged");
const UNKNOWN = [
  "Le service est en maintenance jusqu'à 18h.", "Prisma: connection refused", "تم إيقاف الخدمة مؤقتاً.", "Votre commande arrive bientôt",
  "Nouvelle commande 120 MAD", "Commande livrée", "Bonus offert par l'admin : 50 MAD", "", "   ",
];
for (const lang of ["ar", "fr"]) {
  ok(`${lang}: unknown server text returned unchanged`, UNKNOWN.every((s) => localizeServerError(s, lang) === s), UNKNOWN.filter((s) => localizeServerError(s, lang) !== s));
  ok(`${lang}: unknown notification returned unchanged`, UNKNOWN.every((s) => localizeNotification(s, lang) === s));
  ok(`${lang}: Arabic server text stays exactly as sent`, localizeServerError("تم إيقاف الخدمة مؤقتاً.", lang) === "تم إيقاف الخدمة مؤقتاً." && localizeNotification("رسالة من الإدارة", lang) === "رسالة من الإدارة");
}
ok("unknown text + unknown code → text unchanged; unknown code alone → the code; nothing → ''",
  localizeServerError({ error: "Oups", code: "WHATEVER" }, "ar") === "Oups" && localizeServerError({ code: "WHATEVER" }, "ar") === "WHATEVER"
  && localizeServerError(null, "ar") === "" && localizeServerError(undefined, "fr") === "" && localizeNotification(null, "ar") === "");
ok("knownServerError → null for unknown text / code", knownServerError("Oups", "ar") === null && knownServerError({ code: "WHATEVER" }, "fr") === null);
ok("any other language value falls back to French", localizeServerError("Erreur serveur", "en") === "Erreur serveur" && localizeNotification("Commande livrée: 1 MAD - Client: A", undefined) === "Commande livrée: 1 DH - Client: A");
ok("pure module (no React / DOM / I/O imports)", !/^import /m.test(read("src/lib/serverText/affiliateServerText.js")) && !/window|document|fetch\(/.test(read("src/lib/serverText/affiliateServerText.js").replace(/^\s*(\/\/|\*).*$/gm, "")));

// ── 7. Wiring ─────────────────────────────────────────────────────────────────
console.log("\n7. Wiring in the affiliate pages");
{
  const IMPORT = /import \{ [^}]*\b(localizeServerError|knownServerError)\b[^}]*\} from "@\/lib\/serverText\/affiliateServerText";/;
  const page = read("src/app/affiliate/dashboard/page.jsx");
  ok("dashboard: imports localizeServerError + localizeNotification", /import \{ localizeServerError, localizeNotification \} from "@\/lib\/serverText\/affiliateServerText";/.test(page));
  ok("dashboard: notifications rendered through localizeNotification (stored text never modified)",
    /\{localizeNotification\(n\.message, lang\)\}/.test(page) && !/\{n\.message\}/.test(page) && !/message:\s*localize/.test(page));
  ok("dashboard: feedback { text, code } localized at display (msgText)", /if \(!m\.key\) return localizeServerError\(m, lang\);/.test(page));
  ok("dashboard: bank / payout / claim errors keep text + code", ["setBankError(d.error ? { text: d.error, code: d.code }", "setPayoutMsg(d.error ? { type: \"error\", text: d.error, code: d.code }",
    "setClaimMsg(d.error ? { type: \"error\", text: d.error, code: d.code }"].every((s) => page.includes(s)));
  ok("dashboard: avatar / profile / password alerts localized", (page.match(/alert\(json\.error \? localizeServerError\(json, lang\) :/g) || []).length === 3 && !/alert\(json\.error \|\|/.test(page));
  ok("dashboard: identity upload error localized", /m = \{ text: b\.error, code: b\.code \}/.test(page) && /err\.key \? t\(err\.key\) : localizeServerError\(err, lang\)/.test(page));
  const login = read("src/app/affiliate/login/page.jsx");
  ok("login: server error kept as { text, code } and localized", IMPORT.test(login) && /\{ text: data\.error, code: data\.code \}/.test(login) && /error\.key \? t\(error\.key\) : localizeServerError\(error, lang\)/.test(login));
  const booster = read("src/app/affiliate/dashboard/BoosterTab.jsx");
  ok("booster: purchase error localized", IMPORT.test(booster) && /text: d\.error, code: d\.code/.test(booster) && /msg\.key \? t\(msg\.key, msg\.vars\) : localizeServerError\(msg, lang\)/.test(booster));
  const deposit = read("src/app/affiliate/dashboard/DepositTab.jsx");
  ok("deposit: submit error localized", IMPORT.test(deposit) && /m = \{ text: b\.error, code: b\.code \}/.test(deposit) && /msg\.key \? t\(msg\.key\) : localizeServerError\(msg, lang\)/.test(deposit));
  const ugc = read("src/app/affiliate/dashboard/UgcTab.jsx");
  ok("UGC: upload error localized", IMPORT.test(ugc) && /text: body\.error, code: body\.code/.test(ugc) && /: m \? localizeServerError\(m, lang\) : m\)/.test(ugc));
  const brand = read("src/app/affiliate/dashboard/BrandTab.jsx");
  ok("brand: codes via brandI18n, everything else via the server-text table, never a raw `code_X` key",
    IMPORT.test(brand) && /BRAND_TEXT\.fr\[`code_\$\{code\}`\] !== undefined/.test(brand) && /knownServerError\(r\.data \|\| \{\}, lang\) \?\? t\("error_generic"\)/.test(brand)
    && !/errorText\(r, t\)\)/.test(brand));
  const rewards = read("src/app/affiliate/dashboard/RewardsTab.jsx");
  ok("rewards: unknown codes via the server-text table, else generic (never a raw `code_X` key)",
    IMPORT.test(rewards) && /REWARDS_TEXT\.fr\[`code_\$\{code\}`\] !== undefined/.test(rewards) && /knownServerError\(\{ error: data\?\.error, code \}, lang\) \?\? t\("error_generic"\)/.test(rewards));
  const shown = [page, login, booster, deposit, ugc].map((s) => s.match(/: (?:msg|m|err|error)\.text\}/g) || []).flat();
  ok("no raw server `.text` rendered anywhere", shown.length === 0, shown);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
