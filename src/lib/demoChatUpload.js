/**
 * src/lib/demoChatUpload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Hard request-size limit for DEMO chat media uploads (Phase 3C-3).
 *
 * Route handlers have no default body limit, and `req.formData()` buffers the
 * whole body — so a missing (chunked) or understated Content-Length would let
 * an oversized body be read into memory before any size check. This reads the
 * raw stream with a running byte counter and aborts as soon as the limit is
 * crossed; only a body within the limit is parsed as multipart. Pure web APIs
 * (Request/Response streams), unit-testable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const MULTIPART_OVERHEAD = 256 * 1024; // boundaries + part headers + the `kind` field

const fail = (status, code, message) => Object.assign(new Error(message), { status, code, field: 'file' });

/**
 * Parse a multipart body of at most `maxBytes`. Throws { status: 413 } when the
 * declared or actual size exceeds it, { status: 400 } for a non-multipart body.
 */
export async function readFormDataWithLimit(req, maxBytes) {
  const type = req.headers.get('content-type') || '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) throw fail(400, 'VALIDATION', 'Envoi multipart attendu.');
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail(413, 'FILE_TOO_LARGE', 'Fichier trop lourd.');
  if (!req.body) throw fail(400, 'VALIDATION', 'Aucun fichier fourni.');

  const reader = req.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw fail(413, 'FILE_TOO_LARGE', 'Fichier trop lourd.');
    }
    chunks.push(value);
  }
  try {
    return await new Response(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))), { headers: { 'content-type': type } }).formData();
  } catch {
    throw fail(400, 'VALIDATION', 'Envoi multipart invalide.');
  }
}
