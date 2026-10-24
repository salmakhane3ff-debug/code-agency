/**
 * src/lib/demoChatErrors.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps database errors raised by demo-chat writes to safe HTTP errors
 * (Phase 3C-2). No PostgreSQL text ever reaches the client.
 *
 * The append-only audit trigger raises PostgreSQL P0001 ("… is append-only
 * (UPDATE|DELETE|TRUNCATE rejected)"). Prisma does NOT give it a P20xx code:
 * through the query engine it arrives as PrismaClientUnknownRequestError whose
 * message embeds `PostgresError { code: "P0001", … }` (verified in the Phase
 * 3C-1 temporary-database test); through raw queries it is a P2010 with
 * meta.code "P0001". Both shapes are handled. No service path issues such a
 * write — reaching it means a bug, so it is logged loudly and returned as 500.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const httpError = (status, code, message, field) => Object.assign(new Error(message), { status, code, field: field ?? null });

const textOf = (e) => {
  let meta = '';
  try { meta = JSON.stringify(e?.meta ?? {}); } catch { /* ignore */ }
  return `${e?.message ?? ''} ${meta}`;
};

/** PostgreSQL SQLSTATE carried by a Prisma error, when one can be read. */
export function pgCodeOf(e) {
  if (e?.code === 'P2010' && typeof e?.meta?.code === 'string') return e.meta.code;
  const m = textOf(e).match(/code:\s*"([0-9A-Z]{5})"/);
  if (m) return m[1];
  const m2 = textOf(e).match(/"code"\s*:\s*"([0-9A-Z]{5})"/);
  return m2 ? m2[1] : null;
}

export function isAppendOnlyViolation(e) {
  return pgCodeOf(e) === 'P0001' && /append-only/.test(textOf(e));
}

/**
 * Translate an unknown error into an httpError (or return it unchanged when it
 * already is one). `ctx` labels the server log line.
 */
export function toHttpError(e, ctx = 'demo-chat') {
  if (e?.status) return e;
  if (isAppendOnlyViolation(e)) {
    console.error(`[${ctx}] AUDIT APPEND-ONLY VIOLATION — a code path tried to modify demo_chat_audit_log:`, e?.message);
    return httpError(500, 'AUDIT_APPEND_ONLY', "Journal d'audit en lecture seule : opération refusée.");
  }
  switch (e?.code) {
    case 'P2002': return httpError(409, 'CONFLICT', 'Conflit : cet élément existe déjà (rechargez la page).');
    case 'P2003': return httpError(409, 'REFERENCED', 'Élément utilisé ailleurs : archivez-le au lieu de le supprimer.');
    case 'P2025': return httpError(404, 'NOT_FOUND', 'Élément introuvable.');
    default: break;
  }
  const pg = pgCodeOf(e);
  if (pg === '23514') return httpError(400, 'INVALID', 'Données refusées par les règles de la base.');
  if (pg === 'P0001') { console.error(`[${ctx}] database rule rejected the write:`, e?.message); return httpError(500, 'DB_RULE', 'Opération refusée par la base de données.'); }
  console.error(`[${ctx}] unexpected error:`, e);
  return httpError(500, 'SERVER_ERROR', 'Erreur serveur');
}

/** Admin id recorded in audit rows (same rule as the rewards routes). */
export const actorIdOf = (user) => user?.userId || user?.email || null;

/** Route helper: JSON response for any error thrown by the service. */
export function errorResponse(e, ctx) {
  const h = toHttpError(e, ctx);
  return Response.json({ error: h.message, code: h.code, field: h.field ?? null }, { status: h.status });
}
