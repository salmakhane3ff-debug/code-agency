/**
 * src/lib/recruiterIdentityAdminHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the ADMIN side of the recruiter identity verification (KYC) — Phase 6
 * part 3c. Routes wrap them with withAdminAuth (role ADMIN). Kept apart from the affiliate
 * identity routes (/api/admin/identity), which are not touched.
 *
 *   list    GET  → { verifications: [...] } queue + per-recruiter KYC history (no file key)
 *   decide  PUT  { id, action: 'approve'|'reject', expectedStatus, submission, reason } → decision
 *   image   GET  /[id]/[front|back] → the CIN image, private (no-store, nosniff, image/jpeg)
 * Errors: fixed French text per code, never an internal message. Decisions are audited by the
 * service in recruiter_audit_log (actor = the admin; never a file key or an image).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { adminDecideRecruiterIdentity, adminListRecruiterIdentities, adminRecruiterCinFile } from './services/recruiterIdentityService.js';

const noStore = { 'Cache-Control': 'no-store' };
const json = (body, status = 200) => Response.json(body, { status, headers: noStore });
const ADMIN_ERRORS = {
  INVALID_INPUT: [400, 'Données invalides (un motif de 1 à 500 caractères est requis pour un rejet).'],
  INVALID_STATE: [409, "Action impossible dans l'état actuel (une demande rejetée ne peut être approuvée qu'après un nouvel envoi)."],
  STALE_DECISION: [409, 'La demande a changé entre-temps (nouvel envoi ou autre décision). Rechargez la liste.'],
  UNAUTHORIZED: [401, 'Non autorisé.'],
  NOT_FOUND: [404, 'Vérification introuvable.'],
};
function adminError(e) {
  const known = ADMIN_ERRORS[e?.code];
  if (!known) {
    console.error('[admin recruiter identity]', e?.code ?? 'ERROR');
    return json({ code: 'SERVER_ERROR', error: 'Erreur serveur.' }, 500);
  }
  return json({ code: e.code, error: known[1] }, known[0]);
}
const actorOf = (user) => (user?.userId ? String(user.userId) : user?.email ? String(user.email) : user?.id ? String(user.id) : null);

const imageResponse = (file) => new Response(file.buffer, {
  status: 200,
  headers: {
    'Content-Type': 'image/jpeg', 'Content-Length': String(file.buffer.length),
    'Cache-Control': 'no-store, private', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
  },
});
const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' } });

export function recruiterIdentityAdminHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), read } = deps;
  const safe = (fn) => async (req, ctx, user) => { try { return await fn(req, ctx, user); } catch (e) { return adminError(e); } };
  return {
    list: safe(async () => json({ verifications: await adminListRecruiterIdentities({ db }) })),
    decide: safe(async (req, _ctx, user) => {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
      const { id, ...input } = body;
      return json({ verification: await adminDecideRecruiterIdentity(typeof id === 'string' ? id : '', input, { db, actorId: actorOf(user), now: now() }) });
    }),
    image: async (_req, ctx) => {
      try {
        const p = await ctx?.params;
        const file = await adminRecruiterCinFile(p?.id, p?.side, { db, ...(read ? { read } : {}) });
        return file?.buffer ? imageResponse(file) : notFound();
      } catch (e) {
        console.error('[admin recruiter identity image]', e?.code ?? 'ERROR');
        return new Response('Erreur serveur', { status: 500, headers: { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' } });
      }
    },
  };
}
