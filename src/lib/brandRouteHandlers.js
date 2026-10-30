/**
 * src/lib/brandRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bodies of the "Create Your Own Brand" API routes as dependency-injected
 * handlers (same pattern as rewardsRouteHandlers.js). Route files only wire
 * withAdminAuth / withAffiliateAuth + these handlers; tests inject a fake db.
 *
 * Identity comes ONLY from the verified token payload (admin actor id;
 * affiliate id) — never from the request body.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { publicBrandOffer } from './brandProgram.js';
import {
  getBrandConfig, saveBrandConfig, getRefundTerms, saveRefundTermsDraft, publishRefundTerms, listBrandAudit,
  getEligibleCatalog, listCatalogCandidates,
} from './services/brandProgramService.js';
import {
  getAffiliateAccessRow, publicAccessWithConsent, requestBrandAccess, cancelOwnAccess, recordFreshConsent,
  adminRejectAccess, adminCloseAccess, adminReopenAccess, adminListAccesses,
  adminGrantAuthorization, adminRevokeAuthorization, adminListAuthorizations,
} from './services/brandAccessService.js';
import {
  submitPaymentProof, getOwnPaymentProof, readOwnProofFile, readAdminProofFile, adminAcceptProof, defaultProofStorage,
} from './services/brandPaymentService.js';
import { getPublishedTermsVersion } from './services/brandConsentService.js';
import { DEPOSIT_MAX_BYTES } from './depositStorage.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { getAffiliateSimulationDashboard, getAdminSimulationDashboard } from './services/brandSimulationService.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const json = (data, status = 200) => Response.json(data, { status, headers: NO_STORE });

const STATUS = {
  INVALID_JSON:               400,
  INVALID_INPUT:              400,
  INVALID_BRAND_NAME:         400,
  INVALID_PRODUCT_SELECTION:  400,
  INVALID_WINDOW:             400,
  INVALID_ACTION:             400,
  TERMS_NOT_ACCEPTED:         400,
  PAYMENT_REFERENCE_REQUIRED: 400,
  REASON_REQUIRED:            400,
  INVALID_FILE:               400,
  AFFILIATE_INACTIVE:         403,
  BRAND_DISABLED:             403,
  PACKAGE_NOT_FOUND:          404,
  BRANDING_NOT_FOUND:         404,
  ACCESS_NOT_FOUND:           404,
  NO_ACTIVE_ACCESS:           404,
  PROOF_NOT_FOUND:            404,
  AFFILIATE_NOT_FOUND:        404,
  AUTHORIZATION_NOT_FOUND:    404,
  PACKAGE_REMOVED:            409,
  ACCESS_EXISTS:              409,
  NOT_PENDING:                409,
  IDEMPOTENCY_CONFLICT:       409,
  TERMS_NOT_PUBLISHED:        409,
  TERMS_CHANGED:              409,
  TERMS_EMPTY:                409,
  TERMS_UNCHANGED:            409,
  PRODUCT_NOT_AVAILABLE:      409,
  AUTHORIZATION_REQUIRED:     409,
  AUTHORIZATION_EXISTS:       409,
  NO_CLOSED_ACCESS:           409,
  NOT_REVOCABLE:              409,
  NOT_ACTIVE:                 409,
  NOT_CLOSED:                 409,
  PROOF_EXISTS:               409,
  PROOF_NOT_SUBMITTED:        409,
  DUPLICATE_PROOF:            409,
  CONSENT_UNVERIFIED:         409,
  CONSENT_RENEWAL_REQUIRED:   409,
  CONSENT_NOT_REQUIRED:       409,
  TRY_AGAIN:                  409,
  FILE_TOO_LARGE:             413,
};

/** Coded service errors → HTTP; anything else is a logged generic 500 (message never sent). */
export function brandErrorResponse(e) {
  const status = STATUS[e?.code];
  if (!status) {
    console.error('[brand] unexpected error:', e?.message || e);
    return json({ error: 'Erreur serveur', code: 'SERVER_ERROR' }, 500);
  }
  return json({
    error: e.message, code: e.code,
    ...(e.errors ? { errors: e.errors } : {}),
    ...(Number.isSafeInteger(e.expected) ? { expected: e.expected } : {}), // e.g. a package's exact product count
  }, status);
}

async function readJsonObject(req) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Requête invalide'), { code: 'INVALID_JSON' });
  }
  return body;
}

/** Audit actor from the verified admin session (never from the request). */
export const actorIdOf = (user) => user?.userId || user?.email || null;

const param = async (ctx, name) => (await ctx?.params)?.[name];
const windowOf = (req) => new URL(req.url).searchParams.get('window') || '24h';

/** Proof upload: the file (8 MiB) plus a 64 KiB allowance for multipart framing and the text fields. */
export const PROOF_BODY_LIMIT = DEPOSIT_MAX_BYTES + 64 * 1024; // 8,454,144 bytes

const tooLarge = () => Object.assign(new Error('Fichier trop volumineux (8 Mo maximum).'), { code: 'FILE_TOO_LARGE' });

/**
 * Multipart body read with a hard byte cap WHILE streaming: Content-Length is
 * only an early refusal (it can be absent or false); the stream is cancelled as
 * soon as more than `limit` bytes arrive, so an oversized body is never fully
 * buffered. Only then is the (bounded) body parsed.
 */
export async function readFormDataCapped(req, limit = PROOF_BODY_LIMIT) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!req.body) throw Object.assign(new Error('La preuve du virement est requise.'), { code: 'INVALID_FILE' });
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const contentType = req.headers.get('content-type') || '';
  return new Response(new Blob(chunks), { headers: { 'content-type': contentType } }).formData().catch(() => null);
}

/** A stored proof file, streamed privately (the storage key is never exposed). */
const fileResponse = (file) => new Response(file.buffer, {
  status: 200,
  headers: {
    'Content-Type': file.contentType, 'Content-Length': String(file.buffer.length),
    'Cache-Control': 'no-store, private', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
  },
});

export function adminBrandHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), storage = defaultProofStorage } = deps;
  const safe = (fn) => async (req, ctx, user) => {
    try { return await fn(req, ctx, user); } catch (e) { return brandErrorResponse(e); }
  };
  return {
    getConfig: safe(async () => json(await getBrandConfig(db))),
    /** Store products for the catalogue picker (read only), with eligibility flags. */
    listProducts: safe(async () => json(await listCatalogCandidates({ db }))),
    putConfig: safe(async (req, _ctx, user) =>
      json(await saveBrandConfig(await readJsonObject(req), { db, actorId: actorIdOf(user), now: now() }))),

    getTerms: safe(async () => json(await getRefundTerms(db))),
    putTermsDraft: safe(async (req, _ctx, user) =>
      json(await saveRefundTermsDraft(await readJsonObject(req), { db, actorId: actorIdOf(user), now: now() }))),
    publishTerms: safe(async (_req, _ctx, user) => json(await publishRefundTerms({ db, actorId: actorIdOf(user), now: now() }))),

    listAccesses: safe(async (req) => {
      const sp = new URL(req.url).searchParams;
      return json(await adminListAccesses({ status: (sp.get('status') || 'ALL').toUpperCase(), q: sp.get('q') || '', db }));
    }),
    /**
     * POST { action: 'accept-proof' } | { action: 'reject', reason }
     *    | { action: 'close', reason } | { action: 'reopen', reason }
     * (activation happens ONLY by accepting the payment proof)
     */
    actOnAccess: safe(async (req, ctx, user) => {
      const body = await readJsonObject(req);
      const id = await param(ctx, 'id');
      const opts = { db, actorId: actorIdOf(user), now: now() };
      if (body.action === 'accept-proof') return json(await adminAcceptProof(id, opts));
      if (body.action === 'reject') return json(await adminRejectAccess(id, { reason: body.reason }, opts));
      if (body.action === 'close') return json(await adminCloseAccess(id, { reason: body.reason }, opts));
      if (body.action === 'reopen') return json(await adminReopenAccess(id, { reason: body.reason }, opts));
      throw Object.assign(new Error('Action invalide'), { code: 'INVALID_ACTION' });
    }),
    /** GET → the request's payment proof file (streamed, private). */
    accessProofFile: safe(async (_req, ctx) => fileResponse(await readAdminProofFile(await param(ctx, 'id'), { db, storage }))),

    /** GET ?affiliateId= → new-request authorizations. */
    listAuthorizations: safe(async (req) => {
      const affiliateId = new URL(req.url).searchParams.get('affiliateId');
      if (affiliateId !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(affiliateId)) throw Object.assign(new Error('Requête invalide'), { code: 'INVALID_INPUT' });
      return json(await adminListAuthorizations({ affiliateId, db }));
    }),
    /** POST { affiliateId, reason } → one single-use authorization for a new request. */
    grantAuthorization: safe(async (req, _ctx, user) => {
      const body = await readJsonObject(req);
      return json(await adminGrantAuthorization(body.affiliateId, { reason: body.reason }, { db, actorId: actorIdOf(user) }), 201);
    }),
    /** POST { reason } → revoke an unused authorization. */
    revokeAuthorization: safe(async (req, ctx, user) => {
      const body = await readJsonObject(req);
      return json(await adminRevokeAuthorization(await param(ctx, 'id'), { reason: body.reason }, { db, actorId: actorIdOf(user), now: now() }));
    }),
    accessDashboard: safe(async (req, ctx) =>
      json(await getAdminSimulationDashboard(await param(ctx, 'id'), { db, now: now(), window: windowOf(req) }))),

    /** GET ?entityId=<request id> → only that request's audit rows. */
    listAudit: safe(async (req) => {
      const entityId = req ? new URL(req.url).searchParams.get('entityId') : null;
      if (entityId !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(entityId)) throw Object.assign(new Error('Requête invalide'), { code: 'INVALID_INPUT' });
      return json(await listBrandAudit({ db, entityId }));
    }),
  };
}

export function affiliateBrandHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), storage = defaultProofStorage, rateLimit = defaultRateLimit } = deps;
  const safe = (fn) => async (req, ctx, decoded) => {
    try { return await fn(req, ctx, decoded); } catch (e) { return brandErrorResponse(e); }
  };
  /** The token's affiliate id, if that account exists and is active; else 403. */
  const activeMe = async (decoded) => {
    const id = decoded?.affiliateId;
    const acc = typeof id === 'string' && id
      ? await db.affiliate.findUnique({ where: { id }, select: { isActive: true } })
      : null;
    if (!acc?.isActive) throw Object.assign(new Error('Compte inactif'), { code: 'AFFILIATE_INACTIVE' });
    return id;
  };
  return {
    /** Offer + eligible catalogue (only while enabled), published refund terms, and the participant's own access. */
    overview: safe(async (_req, _ctx, decoded) => {
      const me = await activeMe(decoded);
      const [config, published, row] = await Promise.all([getBrandConfig(db), getPublishedTermsVersion(db), getAffiliateAccessRow(me, db)]);
      const offer = publicBrandOffer(config, config.enabled ? await getEligibleCatalog(config, db) : []);
      const access = await publicAccessWithConsent(row, db);
      // The terms shown are the latest IMMUTABLE published version (exactly what a
      // request or a fresh consent snapshots) — also when a fresh consent is possible.
      const renewable = ['PAYMENT_BLOCKED', 'RENEWAL_REQUIRED'].includes(access?.consentStatus);
      const terms = published && (offer.enabled || renewable)
        ? { version: published.version, text: published.text, publishedAt: new Date(published.publishedAt).toISOString() }
        : null;
      return json({ ...offer, terms, access });
    }),
    /** POST { productIds, packageId, brandName, brandingOptionId?, termsVersion, acceptTerms, clientRequestId } */
    requestAccess: safe(async (req, _ctx, decoded) => {
      const me = await activeMe(decoded);
      return json(await requestBrandAccess(me, await readJsonObject(req), { db, now: now() }), 201);
    }),
    cancelAccess: safe(async (_req, ctx, decoded) => {
      const me = await activeMe(decoded);
      return json(await cancelOwnAccess(me, await param(ctx, 'id'), { db, now: now() }));
    }),
    /** POST multipart { paymentMethod, transferReference?, proof } → the payment proof of the participant's OWN request. */
    submitProof: async (req, ctx, decoded) => {
      const limited = rateLimit(req, 'brand_proof_submit', { max: 10, windowMs: 60_000 });
      if (limited) return limited;
      return safe(async () => {
        const me = await activeMe(decoded);
        const form = await readFormDataCapped(req);
        const file = form?.get('proof');
        if (!file || typeof file.arrayBuffer !== 'function') throw Object.assign(new Error('La preuve du virement est requise.'), { code: 'INVALID_FILE' });
        if (Number(file.size) > DEPOSIT_MAX_BYTES) throw tooLarge();
        const buffer = Buffer.from(await file.arrayBuffer());
        return json(await submitPaymentProof(me, await param(ctx, 'id'), {
          paymentMethod: form.get('paymentMethod'), transferReference: form.get('transferReference'),
          proof: { buffer, mime: file.type || '', size: buffer.length },
        }, { db, storage }), 201);
      })(req, ctx, decoded);
    },
    /**
     * POST { termsVersion, acceptTerms: true } → a FRESH consent to the latest
     * published terms for the participant's OWN request whose original consent
     * cannot be verified. Never reopens a request, never authorizes payment.
     */
    renewConsent: async (req, ctx, decoded) => {
      const limited = rateLimit(req, 'brand_consent_renew', { max: 10, windowMs: 60_000 });
      if (limited) return limited;
      return safe(async () => {
        const me = await activeMe(decoded);
        return json(await recordFreshConsent(me, await param(ctx, 'id'), await readJsonObject(req), { db }), 201);
      })(req, ctx, decoded);
    },
    /** GET → own proof metadata; GET ?file=1 → own proof file (streamed, private). */
    getProof: safe(async (req, ctx, decoded) => {
      const me = await activeMe(decoded);
      const id = await param(ctx, 'id');
      if (new URL(req.url).searchParams.get('file') === '1') return fileResponse(await readOwnProofFile(me, id, { db, storage }));
      return json({ proof: await getOwnPaymentProof(me, id, { db }) });
    }),
    dashboard: safe(async (req, _ctx, decoded) => {
      const me = await activeMe(decoded);
      return json(await getAffiliateSimulationDashboard(me, { db, now: now(), window: windowOf(req) }));
    }),
  };
}
