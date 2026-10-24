/**
 * src/lib/demoChatValidation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, client-safe validation for scripted DEMO chat journeys (Phase 3C-2).
 * Mirrors the CHECK constraints of migration 20261023_demo_chat_journeys (the
 * database stays the backstop) and adds the authoring rules:
 *   • earnings text may only use {amount} {orders} {period}, and must contain
 *     the placeholder of its metric ({orders} for orders, {amount} otherwise);
 *   • text steps carry no placeholders;
 *   • no hand-typed amounts or order counts in ANY step text — figures are
 *     only ever filled in from simulated demo data at display time;
 *   • image / audio steps (Phase 3C-3) reference an uploaded DemoChatAsset of
 *     the same kind and may carry an optional caption (same text rules).
 * Returns { ok, value } / { ok: false, field, error }.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const STEP_TYPES = ['text', 'image', 'audio', 'earnings'];
export const AUTHORABLE_STEP_TYPES = ['text', 'earnings', 'image', 'audio'];
export const MEDIA_STEP_TYPES = ['image', 'audio'];
export const EARNINGS_PERIODS = ['today', 'yesterday', 'week'];
export const EARNINGS_METRICS = ['commission', 'orders', 'revenue'];
export const PLACEHOLDERS = ['{amount}', '{orders}', '{period}'];
export const JOURNEY_DAYS = 30;
export const TODAY_SUMMARY_FROM = '12:00'; // Casablanca: today's summary never before noon
export const MAX_STEPS = 300;
export const MAX_TEXT = 1000;

// Media assets (Phase 3C-3). Server checks the ACTUAL bytes (src/lib/demoChatMedia.js);
// these constants are shared with the admin UI. Audio limits = DB CHECK on demo_chat_assets.
export const ASSET_KINDS = ['image', 'audio'];
export const IMAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // same cap as uploadSecurity.IMAGE_MAX_BYTES
export const IMAGE_INPUT_FORMATS = ['jpeg', 'png', 'webp']; // re-encoded to WebP; GIF/SVG/HEIC rejected
export const AUDIO_MAX_BYTES = 5 * 1024 * 1024;  // 5 MiB = 5 242 880 bytes
export const AUDIO_MAX_DURATION_SEC = 180;       // 3 minutes
export const AUDIO_MIN_DURATION_SEC = 0.5;
export const AUDIO_FORMATS = ['mp3', 'm4a', 'ogg']; // MP3, AAC in MP4/M4A, Ogg Opus/Vorbis
export const MEDIA_HINT = 'Images : JPG, PNG ou WEBP (10 Mo max, converties en WEBP). Audio : MP3, M4A ou OGG (5 Mo et 3 minutes max, converti en M4A/AAC).';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DIGIT = '[0-9\\u0660-\\u0669\\u06F0-\\u06F9]'; // Latin, Arabic-Indic, Persian digits
const CURRENCY = '(?:mad|dhs?|dirhams?|درهم|دراهم|د\\.م\\.?|€|\\$|eur|euros?|usd)';
const COUNT_WORD = '(?:commandes?|cmds?|orders?|ventes?|طلبات|طلبيات|طلبية|طلب|كوموند|كوموندات)';
// "250 MAD", "1 200,50 dh", "MAD 300", "١٥٠ درهم", "12 commandes", "5 طلبات"
const AMOUNT_RES = [
  new RegExp(`${DIGIT}[${DIGIT.slice(1, -1)}\\s.,'’]*\\s*${CURRENCY}(?![a-z])`, 'iu'),
  new RegExp(`(?<![a-z])${CURRENCY}\\s*${DIGIT}`, 'iu'),
  new RegExp(`${DIGIT}+\\s*${COUNT_WORD}`, 'iu'),
];

export const isValidChatId = (id) => typeof id === 'string' && ID_RE.test(id);

const fail = (field, error) => ({ ok: false, field, error });
const cleanText = (s) => (typeof s === 'string' ? s.trim() : '');

/** true when the text contains a typed money amount or order count. */
export function hasHandTypedAmount(text) {
  return typeof text === 'string' && AMOUNT_RES.some((re) => re.test(text));
}

/** Placeholder problems in `text`, or null. `allowed` = permitted tokens. */
function placeholderError(text, allowed) {
  const tokens = text.match(/\{[^{}]*\}/g) || [];
  const bad = tokens.find((t) => !allowed.includes(t));
  if (bad) return allowed.length ? `Variable non autorisée : ${bad} (autorisées : ${allowed.join(' ')}).` : `Pas de variable dans un message texte (${bad}).`;
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))) return 'Accolade isolée : utilisez uniquement {amount}, {orders} ou {period}.';
  return null;
}

/** Journey header fields. `partial` = PATCH (only sent keys). */
export function validateJourneyInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(null, 'Données invalides');
  const allowed = ['name', 'description'];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) return fail(unknown[0], `Champ non modifiable : ${unknown[0]}`);
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 80) return fail('name', 'Nom : 2 à 80 caractères.');
    out.name = name;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') return fail('description', 'Description invalide.');
    const d = (body.description || '').trim();
    if (d.length > 500) return fail('description', 'Description : 500 caractères maximum.');
    out.description = d;
  }
  if (partial && !Object.keys(out).length) return fail(null, 'Aucun champ à modifier.');
  return { ok: true, value: out };
}

/**
 * One step. Full validation of the resulting row (create, or merge of an
 * existing step with a PATCH). Never accepts ids, journeyId or assetId.
 */
export function validateStepInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(null, 'Données invalides');
  const allowed = ['day', 'time', 'position', 'type', 'text', 'earningsPeriod', 'metric', 'assetId'];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) return fail(unknown[0], `Champ non modifiable : ${unknown[0]}`);

  const { day, time, type } = body;
  const position = body.position === undefined || body.position === null ? 0 : body.position;
  if (!Number.isInteger(day) || day < 1 || day > JOURNEY_DAYS) return fail('day', `Jour : entier de 1 à ${JOURNEY_DAYS}.`);
  if (typeof time !== 'string' || !TIME_RE.test(time)) return fail('time', 'Heure : format HH:MM (00:00 à 23:59, heure de Casablanca).');
  if (!Number.isInteger(position) || position < 0 || position > 99) return fail('position', 'Ordre : entier de 0 à 99.');
  if (!STEP_TYPES.includes(type) || !AUTHORABLE_STEP_TYPES.includes(type)) return fail('type', 'Type : text, earnings, image ou audio.');

  const text = cleanText(body.text);
  if (text.length > MAX_TEXT) return fail('text', `Message : ${MAX_TEXT} caractères maximum.`);
  if (hasHandTypedAmount(text)) {
    return fail('text', 'Montants et nombres de commandes saisis à la main interdits : utilisez {amount} / {orders} (valeurs simulées).');
  }

  if (MEDIA_STEP_TYPES.includes(type)) {
    if (!isValidChatId(body.assetId)) return fail('assetId', type === 'image' ? 'Choisissez une image de la bibliothèque.' : 'Choisissez une note vocale de la bibliothèque.');
    if (body.earningsPeriod != null || body.metric != null) return fail('earningsPeriod', 'Période et indicateur : réservés aux messages de gains.');
    if (text) { const pe = placeholderError(text, []); if (pe) return fail('text', pe); }
    return { ok: true, value: { day, time, position, type, text: text || null, earningsPeriod: null, metric: null, assetId: body.assetId } };
  }

  if (body.assetId != null) return fail('assetId', 'Seuls les messages image ou audio utilisent un média.');
  if (!text) return fail('text', 'Le message ne peut pas être vide.');

  if (type === 'text') {
    if (body.earningsPeriod != null || body.metric != null) return fail('earningsPeriod', 'Période et indicateur : réservés aux messages de gains.');
    const pe = placeholderError(text, []);
    if (pe) return fail('text', pe);
    return { ok: true, value: { day, time, position, type, text, earningsPeriod: null, metric: null, assetId: null } };
  }

  // earnings
  const { earningsPeriod, metric } = body;
  if (!EARNINGS_PERIODS.includes(earningsPeriod)) return fail('earningsPeriod', "Période : today, yesterday ou week.");
  if (!EARNINGS_METRICS.includes(metric)) return fail('metric', 'Indicateur : commission, orders ou revenue.');
  if (earningsPeriod === 'today' && time < TODAY_SUMMARY_FROM) return fail('time', "Le bilan du jour n'est envoyé qu'à partir de 12:00 (Casablanca).");
  const pe = placeholderError(text, PLACEHOLDERS);
  if (pe) return fail('text', pe);
  const needed = metric === 'orders' ? '{orders}' : '{amount}';
  if (!text.includes(needed)) return fail('text', `Le message doit contenir ${needed} (indicateur « ${metric} »).`);
  return { ok: true, value: { day, time, position, type, text, earningsPeriod, metric, assetId: null } };
}

/** Reorder payload: [{ id, position }] (positions 0..99, ids unique). */
export function validateReorderInput(body) {
  const items = body?.steps;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_STEPS) return fail('steps', 'Liste invalide.');
  const seen = new Set();
  for (const it of items) {
    if (!it || !isValidChatId(it.id) || seen.has(it.id)) return fail('steps', 'Étape invalide ou en double.');
    if (!Number.isInteger(it.position) || it.position < 0 || it.position > 99) return fail('steps', 'Ordre : entier de 0 à 99.');
    seen.add(it.id);
  }
  return { ok: true, value: items.map(({ id, position }) => ({ id, position })) };
}

/** Optimistic-concurrency token sent by every journey-scoped write. */
export function readExpectedUpdatedAt(body) {
  const v = body?.expectedUpdatedAt;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return null;
  return new Date(v).toISOString();
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Stable, ordered snapshot of steps — what a published version freezes and hashes. */
export function canonicalSteps(steps) {
  return [...steps]
    .sort((a, b) => a.day - b.day || cmp(a.time, b.time) || a.position - b.position || cmp(a.id, b.id))
    .map((s) => ({
      id: s.id, day: s.day, time: s.time, position: s.position ?? 0, type: s.type,
      text: s.text ?? null, assetId: s.assetId ?? null,
      earningsPeriod: s.earningsPeriod ?? null, metric: s.metric ?? null,
    }));
}

/** Whole-journey check before publishing; returns { ok } or the first problem. */
export function validateForPublish(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return fail('steps', 'Ajoutez au moins une étape avant de publier.');
  if (steps.length > MAX_STEPS) return fail('steps', `${MAX_STEPS} étapes maximum.`);
  const slots = new Set();
  for (const s of steps) {
    const v = validateStepInput({ day: s.day, time: s.time, position: s.position, type: s.type, text: s.text, earningsPeriod: s.earningsPeriod, metric: s.metric, assetId: s.assetId });
    if (!v.ok) return fail('steps', `Jour ${s.day} ${s.time} : ${v.error}`);
    const k = `${s.day}|${s.time}|${s.position ?? 0}`;
    if (slots.has(k)) return fail('steps', `Jour ${s.day} ${s.time} : deux étapes au même emplacement.`);
    slots.add(k);
  }
  return { ok: true };
}

/** Labelled SAMPLE values used by the admin preview — never real or demo data. */
export const PREVIEW_SAMPLE = Object.freeze({ amount: '123,45 MAD', orders: '7', period: { today: "aujourd'hui", yesterday: 'hier', week: 'cette semaine' } });

/** Fill placeholders with sample values for the admin preview. */
export function renderPreviewText(step) {
  if (step.type !== 'earnings') return step.text || '';
  return String(step.text || '')
    .replaceAll('{amount}', PREVIEW_SAMPLE.amount)
    .replaceAll('{orders}', PREVIEW_SAMPLE.orders)
    .replaceAll('{period}', PREVIEW_SAMPLE.period[step.earningsPeriod] || '');
}
