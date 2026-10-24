/**
 * src/lib/rewardsHttp.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps rewards-service coded errors to consistent HTTP responses (transport
 * concern only — same pattern as ugcHttp.js). Unknown errors become a generic
 * 500 and are logged; their message is never sent to the client.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const STATUS = {
  INVALID_JSON:           400,
  INVALID_INPUT:          400,
  NOT_FOUND:              404,
  GIFT_NOT_FOUND:         404,
  AFFILIATE_NOT_FOUND:    404,
  INVALID_TRANSITION:     409,
  IDEMPOTENCY_CONFLICT:   409,
  INSUFFICIENT_POINTS:    409,
  OUT_OF_STOCK:           409,
  STOCK_NEGATIVE:         409,
  GIFT_ARCHIVED:          409,
  GIFT_UNAVAILABLE:       409,
  GIFT_LIMIT_REACHED:     409,
  TOO_MANY_OPEN_REQUESTS: 409,
  MIN_ORDERS_NOT_MET:     409,
  RECONCILE_IN_PROGRESS:  409,
  AFFILIATE_INACTIVE:     403,
  REWARDS_DISABLED:       403,
  BASELINE_LOCK_TIMEOUT:  503,
};

export function rewardsErrorResponse(err) {
  const code = err && err.code;
  const status = STATUS[code];
  if (!status) {
    console.error('[rewards] unexpected error:', (err && err.message) || err);
    return Response.json({ error: 'Erreur serveur', code: 'SERVER_ERROR' }, { status: 500 });
  }
  return Response.json(
    { error: err.message, code, ...(err.errors ? { errors: err.errors } : {}) },
    { status },
  );
}

/** Parse a JSON object body; malformed / non-object → INVALID_JSON (400). */
export async function readJsonObject(req) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Requête invalide'), { code: 'INVALID_JSON' });
  }
  return body;
}
