/**
 * src/lib/recruiterIdentityRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the recruiter's OWN identity verification (KYC) — Phase 6 part 3c.
 * Routes wrap them with withRecruiterAuth; tests inject a fake db, clock, storage and limiter.
 *
 *   identity  GET  → { identity }   status, rejection reason, dates, canSubmit (no file key)
 *   submit    POST multipart { front, back } → 201 { identity }
 *
 * The recruiter id always comes from the session, never from the request. Every request
 * re-checks the account (active, session version). Uploads: the multipart body is capped
 * WHILE streaming (two 5 MB files + framing), each file is checked by its real signature
 * (recruiterIdentityService.checkCinFile), re-encoded by sharp and stored under a UUID key.
 * Responses go through recruiterVisibility only: never a file key, path, reviewer or image.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { requireActiveRecruiter } from './services/recruiterService.js';
import { getRecruiterIdentity, submitRecruiterIdentity, RECRUITER_IDENTITY_LIMITS } from './services/recruiterIdentityService.js';
import { toRecruiterError as defaultToRecruiterError, toRecruiterIdentityView } from './recruiterVisibility.js';
import { json, recruiterErrorResponse } from './recruiterRouteHandlers.js';

export const RECRUITER_IDENTITY_RATE = Object.freeze({ read: { max: 60, windowMs: 60_000 }, write: { max: 5, windowMs: 15 * 60_000 } });
/** Whole multipart body: two files of at most 5 MB each + 64 KiB of framing. */
export const RECRUITER_IDENTITY_BODY_LIMIT = 2 * RECRUITER_IDENTITY_LIMITS.FILE_MAX_BYTES + 64 * 1024;
/** HTTP status of the KYC codes (a refused submission, never a server error). */
export const RECRUITER_IDENTITY_STATUS_CODES = Object.freeze({ IDENTITY_SUBMISSION_NOT_ALLOWED: 409 });

const invalid = (fields) => Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT', fields });

/** Read the multipart body with a hard byte cap WHILE streaming (never fully buffered when oversized). */
async function readCappedFormData(req, limit) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw invalid({ body: 'TOO_LARGE' });
  if (!req.body) throw invalid({ front: 'FILE_REQUIRED', back: 'FILE_REQUIRED' });
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw invalid({ body: 'TOO_LARGE' });
    }
    chunks.push(value);
  }
  const contentType = req.headers.get('content-type') || '';
  if (!/^multipart\/form-data;/i.test(contentType)) throw invalid({ front: 'FILE_REQUIRED', back: 'FILE_REQUIRED' });
  return new Response(new Blob(chunks), { headers: { 'content-type': contentType } }).formData().catch(() => null);
}

/** One form entry → { buffer, mime } (declared MIME, verified against the signature later), or null. */
async function fileOf(form, name) {
  const f = form?.get(name);
  if (!f || typeof f === 'string' || typeof f.arrayBuffer !== 'function') return null;
  return { buffer: Buffer.from(await f.arrayBuffer()), mime: typeof f.type === 'string' ? f.type : '' };
}

export function recruiterIdentityHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), rateLimit = defaultRateLimit, toRecruiterError = defaultToRecruiterError, storage } = deps;
  const safe = (kind, fn) => async (req, _ctx, decoded) => {
    try {
      const rid = typeof decoded?.recruiterId === 'string' ? decoded.recruiterId : '-';
      if (rateLimit(req, `recruiter-identity-${kind}:${rid}`, RECRUITER_IDENTITY_RATE[kind])) return json({ code: 'RATE_LIMITED' }, 429);
      const me = await requireActiveRecruiter(decoded, { db });
      return await fn(req, me);
    } catch (e) {
      return recruiterErrorResponse(e, toRecruiterError, RECRUITER_IDENTITY_STATUS_CODES);
    }
  };
  return {
    identity: safe('read', async (_req, me) => json({ identity: toRecruiterIdentityView(await getRecruiterIdentity(me.id, { db })) })),
    submit: safe('write', async (req, me) => {
      const form = await readCappedFormData(req, RECRUITER_IDENTITY_BODY_LIMIT);
      if (!form) throw invalid({ front: 'FILE_REQUIRED', back: 'FILE_REQUIRED' });
      const files = { front: await fileOf(form, 'front'), back: await fileOf(form, 'back') };
      await submitRecruiterIdentity(me.id, files, { db, now: now(), ...(storage ? { storage } : {}) });
      return json({ identity: toRecruiterIdentityView(await getRecruiterIdentity(me.id, { db })) }, 201);
    }),
  };
}
