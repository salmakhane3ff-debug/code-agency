/**
 * src/lib/paymentProofRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the Payment Proofs API (admin-managed display feed). The route
 * files only wrap them with withAdminAuth / withAffiliateAuth; tests inject a fake
 * db, storage, clock and rate limiter.
 *
 *   Admin (role ADMIN only): list, review a batch, create one proof (multipart),
 *     edit before publication, cancel, publish now, remove ("Supprimer"), receipt image,
 *     audit history, and the global display-duration setting.
 *   Affiliate (GET only, ACTIVE affiliates — the same existence + isActive check
 *     the CYOB affiliate routes use): the ONE global feed and the receipt image of
 *     a proof visible right now. Nothing is filtered by affiliate.
 *
 * Publication is never triggered here (dedicated PM2 worker only).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { defaultPaymentProofStorage, PROOF_IMAGE_MAX_BYTES } from './paymentProofStorage.js';
import {
  createPaymentProof, validatePaymentProofBatch, updatePaymentProofSchedule, cancelPaymentProof, publishPaymentProofNow,
  listPaymentProofsAdmin, readAdminPaymentProofImage, listVisiblePaymentProofs, readVisiblePaymentProofImage,
  listPaymentProofEvents, removePaymentProof,
} from './services/paymentProofService.js';
import { getPaymentProofDisplaySettings, savePaymentProofDisplaySettings } from './services/paymentProofSettingsService.js';

const STATUS = {
  INVALID_INPUT: 400, INVALID_FILE: 400, BODY_TOO_LARGE: 413,
  CLIENT_REF_CONFLICT: 409, DUPLICATE_RECEIPT: 409, NOT_EDITABLE: 409, NOT_CANCELLABLE: 409, RECEIPT_MISSING: 409,
  NOT_PUBLISHABLE: 409, PUBLISH_FAILED: 422, INVALID_DURATION: 400, SETTINGS_CONFLICT: 409,
  NOT_FOUND: 404, UNAUTHORIZED: 401, AFFILIATE_INACTIVE: 403,
};

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export function proofErrorResponse(e) {
  const status = STATUS[e?.code];
  if (!status) {
    console.error('[payment-proofs]', e?.message ?? e);
    return json({ error: 'Erreur serveur.', code: 'SERVER_ERROR' }, 500);
  }
  return json({
    error: e.message, code: e.code, ...(e.errors ? { errors: e.errors } : {}), ...(e.status ? { status: e.status } : {}),
    ...(e.reason ? { reason: e.reason } : {}), ...(e.proof ? { proof: e.proof } : {}), ...(e.current ? { current: e.current } : {}),
  }, status);
}

const param = async (ctx, name) => (await ctx?.params)?.[name];
const actorOf = (user) => (user?.userId ? String(user.userId) : user?.email ? String(user.email) : null);
const bad = (msg = 'Requête invalide.') => Object.assign(new Error(msg), { code: 'INVALID_INPUT' });

async function readJsonObject(req) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad();
  return body;
}

/** Multipart body read with a hard cap: an oversized upload is cut off, never fully buffered. */
export const PROOF_BODY_LIMIT = PROOF_IMAGE_MAX_BYTES + 64 * 1024;
async function readFormDataCapped(req, limit = PROOF_BODY_LIMIT) {
  const tooLarge = () => Object.assign(new Error('Fichier trop volumineux (8 Mo maximum).'), { code: 'BODY_TOO_LARGE' });
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!req.body) throw bad();
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
  const form = await new Response(new Blob(chunks), { headers: { 'content-type': req.headers.get('content-type') || '' } }).formData().catch(() => null);
  if (!form) throw bad();
  return form;
}

const imageResponse = (file) => new Response(file.buffer, {
  status: 200,
  headers: {
    'Content-Type': 'image/jpeg', 'Content-Length': String(file.buffer.length),
    'Cache-Control': 'no-store, private', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
  },
});

export function adminPaymentProofHandlers(deps = {}) {
  const { db = prisma, storage = defaultPaymentProofStorage, now = () => new Date() } = deps;
  const safe = (fn) => async (req, ctx, user) => { try { return await fn(req, ctx, user); } catch (e) { return proofErrorResponse(e); } };
  return {
    /** GET ?status=ALL|SCHEDULED|PUBLISHED|CANCELLED|FAILED&batchId=&page= */
    list: safe(async (req) => {
      const sp = new URL(req.url).searchParams;
      return json(await listPaymentProofsAdmin({
        status: (sp.get('status') || 'ALL').toUpperCase(), batchId: sp.get('batchId') || null, page: Number(sp.get('page')) || 1, db, now: now(),
      }));
    }),
    /**
     * POST multipart: displayName, amount, date (YYYY-MM-DD), time (HH:MM, Casablanca), clientRef, batchId?,
     * privacyConfirmed=true, authenticityConfirmed=true, receipt (image), publishMode? ('now' → published
     * right after creation, no date / time; the response carries `publication`).
     */
    create: safe(async (req, _ctx, user) => {
      const form = await readFormDataCapped(req);
      const field = (k) => { const v = form.get(k); return typeof v === 'string' ? v : undefined; };
      const f = form.get('receipt');
      const file = f && typeof f === 'object' && typeof f.arrayBuffer === 'function'
        ? { buffer: Buffer.from(await f.arrayBuffer()), mime: f.type, size: f.size }
        : null;
      const input = {
        displayName: field('displayName'), amount: field('amount'), date: field('date'), time: field('time'),
        clientRef: field('clientRef'), batchId: field('batchId') || null, publishMode: field('publishMode'),
        privacyConfirmed: field('privacyConfirmed'), authenticityConfirmed: field('authenticityConfirmed'),
      };
      const out = await createPaymentProof(input, file, { db, storage, now: now(), clock: now, actorId: actorOf(user) });
      return json(out, out.existing ? 200 : 201);
    }),
    /** POST { items: [{ displayName, amount, date, time, clientRef, batchId?, privacyConfirmed, authenticityConfirmed }] } → review (nothing written). */
    validateBatch: safe(async (req) => {
      const body = await readJsonObject(req);
      return json(await validatePaymentProofBatch(body.items, { db, now: now() }));
    }),
    /** PATCH { date, time, displayName?, amount?, privacyConfirmed: true, authenticityConfirmed: true } → edit before publication. */
    update: safe(async (req, ctx, user) => {
      const body = await readJsonObject(req);
      return json(await updatePaymentProofSchedule(await param(ctx, 'id'), body, { db, storage, now: now(), actorId: actorOf(user) }));
    }),
    /**
     * POST { action: 'cancel' } | { action: 'publish_now' } (a SCHEDULED proof, before its time — same pipeline as the worker)
     *    | { action: 'remove' } ("Supprimer": hidden from every affiliate at once, record + history kept; idempotent)
     */
    act: safe(async (req, ctx, user) => {
      const body = await readJsonObject(req);
      if (body.action === 'publish_now') {
        return json(await publishPaymentProofNow(await param(ctx, 'id'), { db, storage, clock: now, actorId: actorOf(user) }));
      }
      if (body.action === 'remove') {
        return json(await removePaymentProof(await param(ctx, 'id'), { db, now: now(), actorId: actorOf(user) }));
      }
      if (body.action !== 'cancel') throw bad('Action invalide.');
      return json(await cancelPaymentProof(await param(ctx, 'id'), { db, now: now(), actorId: actorOf(user) }));
    }),
    image: safe(async (_req, ctx) => imageResponse(await readAdminPaymentProofImage(await param(ctx, 'id'), { db, storage }))),
    /** GET → audit history of one proof. */
    events: safe(async (_req, ctx) => json(await listPaymentProofEvents(await param(ctx, 'id'), { db }))),
    /** GET → the global display duration ("Durée d'affichage"): { hours, preset, label, presets, history, revision, … }. */
    getSettings: safe(async () => json(await getPaymentProofDisplaySettings({ db }))),
    /** PUT { hours, revision } → save it (applies to proofs published from now on; never to proofs already published). */
    saveSettings: safe(async (req, _ctx, user) => {
      const body = await readJsonObject(req);
      return json(await savePaymentProofDisplaySettings({ hours: body.hours, revision: body.revision }, { db, now: now(), actorId: actorOf(user) }));
    }),
  };
}

export function affiliatePaymentProofHandlers(deps = {}) {
  const { db = prisma, storage = defaultPaymentProofStorage, now = () => new Date(), rateLimit = defaultRateLimit } = deps;
  const safe = (fn) => async (req, ctx, decoded) => { try { return await fn(req, ctx, decoded); } catch (e) { return proofErrorResponse(e); } };
  /** Same rule as the CYOB affiliate routes: the token's account must exist and be active (isActive). */
  const activeMe = async (decoded) => {
    const id = decoded?.affiliateId;
    const acc = typeof id === 'string' && id
      ? await db.affiliate.findUnique({ where: { id }, select: { isActive: true } })
      : null;
    if (!acc?.isActive) throw Object.assign(new Error('Compte inactif'), { code: 'AFFILIATE_INACTIVE' });
  };
  return {
    /** GET ?cursor= → one page of the global feed (proofs still on display): { proofs, total, nextCursor }. */
    list: safe(async (req, _ctx, decoded) => {
      const limited = rateLimit(req, 'payment_proofs_feed', { max: 60, windowMs: 60_000 });
      if (limited) return limited;
      await activeMe(decoded);
      const cursor = new URL(req.url).searchParams.get('cursor');
      return json(await listVisiblePaymentProofs({ db, now: now(), cursor }));
    }),
    /** GET the receipt of a proof that is visible right now; anything else → 404. */
    image: safe(async (req, ctx, decoded) => {
      const limited = rateLimit(req, 'payment_proofs_image', { max: 240, windowMs: 60_000 });
      if (limited) return limited;
      await activeMe(decoded);
      return imageResponse(await readVisiblePaymentProofImage(await param(ctx, 'token'), { db, storage, now: now() }));
    }),
  };
}
