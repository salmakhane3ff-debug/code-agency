/**
 * src/lib/r2.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloudflare R2 (S3-compatible) storage backend. SERVER-ONLY.
 *
 * Configuration is read ONLY from environment variables — no secrets or hosts
 * are ever hard-coded here:
 *   R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_ENDPOINT R2_PUBLIC_URL R2_PREFIX
 * (R2_ACCOUNT_ID is only used to compose R2_ENDPOINT in .env; not required here.)
 *
 * @aws-sdk/client-s3 is imported LAZILY (dynamic import) inside r2Deps(), so:
 *   - the pure helpers below import cleanly in unit tests without the SDK, and
 *   - saveMediaR2()/destroyByUrlR2() accept injectable `deps` so tests never hit
 *     the network.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'node:crypto';
import path from 'node:path';

export const R2_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv|ogv|ogg|m4v)$/i;

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  ogv: 'video/ogg', ogg: 'video/ogg', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
};

export function extOf(name) {
  return path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
}
export function contentTypeFor(name, fallback = 'application/octet-stream') {
  return MIME[extOf(name)] || fallback;
}
export function detectResourceType(name) {
  return VIDEO_EXT.test(String(name || '')) ? 'video' : 'image';
}
export function shortHash(str, len = 10) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, len);
}

// ── config (env only) ─────────────────────────────────────────────────────────

/** Normalize R2_PREFIX: trim slashes, reject traversal, collapse inner slashes. */
export function normalizePrefix(raw) {
  const p = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!p) return '';
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error('R2_PREFIX must not contain path-traversal segments');
  }
  return p;
}
/** Normalize R2_PUBLIC_URL: trim trailing slashes. */
export function normalizePublicUrl(raw) {
  return String(raw ?? '').trim().replace(/\/+$/g, '');
}

const REQUIRED = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_PUBLIC_URL', 'R2_PREFIX'];

/** { ok, missing[] } — names only, never values. */
export function r2ConfigStatus(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  return { ok: missing.length === 0, missing };
}
export function isR2Configured(env = process.env) {
  return r2ConfigStatus(env).ok;
}
/** Validated config object. Throws (names only) if incomplete. */
export function r2Config(env = process.env) {
  const { ok, missing } = r2ConfigStatus(env);
  if (!ok) throw new Error(`R2 config incomplete: missing ${missing.join(', ')}`);
  return {
    endpoint:        String(env.R2_ENDPOINT).trim(),
    bucket:          String(env.R2_BUCKET).trim(),
    accessKeyId:     String(env.R2_ACCESS_KEY_ID).trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim(),
    publicUrl:       normalizePublicUrl(env.R2_PUBLIC_URL),
    prefix:          normalizePrefix(env.R2_PREFIX),
  };
}

// ── object keys ────────────────────────────────────────────────────────────────

function sanitizeSegment(s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Build a collision-safe object key: <prefix>/<category>/<name>[-<suffix>]<ext>
 *  - deterministic=true  → no random suffix (caller's filename is already unique,
 *    e.g. migration filename that embeds a hash of the source URL)
 *  - deterministic=false → append a random suffix (normal admin uploads)
 * Segments are sanitized; traversal is impossible (basename + sanitize).
 */
export function buildObjectKey({ prefix, category, filename, deterministic = false, suffix }) {
  const safePrefix = normalizePrefix(prefix);
  const cat = sanitizeSegment(category) || 'misc';
  const base = path.basename(String(filename || 'file'));
  const ext = path.extname(base);
  const nameNoExt = sanitizeSegment(base.slice(0, base.length - ext.length)) || 'file';
  const safeExt = ext ? '.' + sanitizeSegment(ext.slice(1)) : '';
  const namePart = deterministic
    ? `${nameNoExt}${safeExt}`
    : `${nameNoExt}-${suffix || crypto.randomBytes(4).toString('hex')}${safeExt}`;
  return [safePrefix, cat, namePart].filter(Boolean).join('/');
}

/** R2_PUBLIC_URL + "/" + encoded key (per-segment encoding; slashes preserved). */
export function publicUrlForKey(publicUrl, key) {
  const base = normalizePublicUrl(publicUrl);
  const encoded = String(key).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${base}/${encoded}`;
}

/** True when `url` is served by this R2 public origin (protocol + host match). */
export function isR2Url(url, publicUrl = process.env.R2_PUBLIC_URL) {
  if (!url || typeof url !== 'string' || !publicUrl) return false;
  let u, base;
  try { u = new URL(url); base = new URL(normalizePublicUrl(publicUrl)); } catch { return false; }
  return u.protocol === base.protocol && u.host === base.host;
}

/**
 * Derive the object key from an R2 URL. Returns null for non-R2 / malformed /
 * empty / traversal, and (when enforced) for keys outside the configured prefix.
 */
export function keyFromUrl(url, { publicUrl = process.env.R2_PUBLIC_URL, prefix, enforcePrefix = false } = {}) {
  if (!isR2Url(url, publicUrl)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return null; } });
  if (segs.length === 0 || segs.some((s) => s === null || s === '..' || s === '.')) return null;
  const key = segs.join('/');
  if (!key) return null;
  if (enforcePrefix && prefix) {
    const p = normalizePrefix(prefix);
    if (p && key !== p && !key.startsWith(p + '/')) return null;
  }
  return key;
}

/** Category from the route's folder + resource type (keeps upload routes unchanged). */
export function categoryFor(folder, resourceType) {
  if (resourceType === 'video') return 'videos';
  const f = String(folder || '').split('/').filter(Boolean).pop();
  if (f === 'avatars') return 'avatars';
  if (f === 'receipts') return 'receipts';
  return 'products';
}

// ── S3 client + real deps (SDK loaded lazily) ──────────────────────────────────

let _clientPromise = null;
async function getClient(env = process.env) {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const cfg = r2Config(env);
      return new S3Client({
        region: 'auto',
        endpoint: cfg.endpoint,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
    })();
  }
  return _clientPromise;
}

/** Real put/delete backed by the SDK. Injectable equivalent used by tests. */
export function r2Deps(env = process.env) {
  return {
    putObject: async ({ bucket, key, body, contentType, cacheControl }) => {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await getClient(env);
      return client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl,
      }));
    },
    deleteObject: async ({ bucket, key }) => {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await getClient(env);
      return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

// ── safe error diagnostics ─────────────────────────────────────────────────────

/**
 * The safe, useful part of an S3/R2 SDK error: HTTP status, error code, request id and a
 * message with the configured credentials scrubbed. The raw SDK error is NEVER logged or
 * re-thrown as is: S3-style errors can carry extra parsed fields (AWSAccessKeyId,
 * StringToSign, SignatureProvided, CanonicalRequest…) and the raw HTTP response, which
 * callers that `console.error(err)` would print.
 */
export function r2ErrorInfo(err, cfg = {}) {
  let message = String(err?.message || err || 'unknown error').slice(0, 300);
  for (const secret of [cfg.accessKeyId, cfg.secretAccessKey]) {
    if (secret && String(secret).length >= 4) message = message.split(String(secret)).join('[redacted]');
  }
  const status = err?.$metadata?.httpStatusCode ?? err?.$response?.statusCode ?? err?.statusCode;
  return {
    status: Number.isInteger(status) ? status : undefined,
    code: String(err?.Code || err?.code || err?.name || 'Error').slice(0, 80),
    requestId: err?.$metadata?.requestId || undefined,
    message,
  };
}

// ── facade: upload + delete (deps injectable for tests) ─────────────────────────

/**
 * Upload a buffer to R2. Returns a result compatible with existing callers.
 * Only genuinely-available metadata is returned (bytes, format) — width/height/
 * duration are NOT fabricated.
 *
 * opts: { filename, category, resourceType, deterministic, contentType }
 */
export async function saveMediaR2(buffer, opts = {}, deps, env = process.env) {
  const d = deps || r2Deps(env);
  const cfg = r2Config(env); // throws (names only) if incomplete
  const { filename, category, resourceType, deterministic = false, contentType } = opts;
  const rtype = resourceType || detectResourceType(filename);
  const cat = category || categoryFor(undefined, rtype);
  const key = buildObjectKey({ prefix: cfg.prefix, category: cat, filename, deterministic });
  const ct = contentType || contentTypeFor(filename);

  try {
    await d.putObject({ bucket: cfg.bucket, key, body: buffer, contentType: ct, cacheControl: R2_CACHE_CONTROL });
  } catch (err) {
    // Diagnostics without secrets: bucket / key / category / type / size + status / code / request id.
    const info = r2ErrorInfo(err, cfg);
    console.error('[r2] upload failed', {
      bucket: cfg.bucket, key, category: cat, resourceType: rtype, contentType: ct, bytes: buffer?.length,
      status: info.status, code: info.code, requestId: info.requestId, message: info.message,
    });
    // A clean error (no raw SDK object / response / signing fields) for the caller to log. Its `code` is the generic
    // R2_UPLOAD_FAILED and it has NO `status`: shared route error mappers treat `code` / `status` as a client-facing
    // answer (e.g. demoCompetition errorResponse), so a storage failure stays a 500 there; the provider's own code and
    // HTTP status are kept separately (r2Code / httpStatus) for logs only.
    const safe = new Error(`R2 upload failed: ${info.code}${info.status ? ` (HTTP ${info.status})` : ''} — ${info.message}`);
    safe.name = 'R2UploadError';
    safe.code = 'R2_UPLOAD_FAILED';
    safe.r2Code = info.code;
    safe.httpStatus = info.status;
    safe.key = key;
    throw safe;
  }

  const url = publicUrlForKey(cfg.publicUrl, key);
  const format = extOf(filename) || undefined;
  return {
    storage: 'r2',
    url, secure_url: url,
    key, public_id: key,
    resource_type: rtype, resourceType: rtype,
    bytes: buffer?.length ?? undefined,
    format,
    contentType: ct,
    // width/height/duration intentionally omitted (not parsed — never fabricated).
  };
}

/**
 * Delete an R2 object by its public URL. Only deletes URLs that belong to
 * R2_PUBLIC_URL and lie under R2_PREFIX. Never throws for skip cases.
 */
export async function destroyByUrlR2(url, deps, env = process.env) {
  const publicUrl = env.R2_PUBLIC_URL;
  if (!isR2Url(url, publicUrl)) return { ok: false, skipped: true, reason: 'wrong-host' };
  const key = keyFromUrl(url, { publicUrl, prefix: env.R2_PREFIX, enforcePrefix: true });
  if (!key) return { ok: false, skipped: true, reason: 'invalid-key' };
  let cfg = {};
  try {
    const d = deps || r2Deps(env);
    cfg = r2Config(env);
    await d.deleteObject({ bucket: cfg.bucket, key });
    return { ok: true, storage: 'r2', result: 'deleted', key, publicId: key };
  } catch (err) {
    const info = r2ErrorInfo(err, cfg);
    return { ok: false, storage: 'r2', error: info.message, code: info.code, status: info.status, key, publicId: key };
  }
}
