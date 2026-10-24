/**
 * src/lib/cloudinary.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single reusable media-storage service (SERVER-ONLY — never import from a
 * client component; it uses the Cloudinary Node SDK and reads the API secret).
 *
 * Phase 1 goal: introduce Cloudinary WITHOUT activating it.
 *
 *   saveMedia(buffer, opts)  ← the one facade every upload route calls.
 *     • MEDIA_STORAGE=cloudinary  → upload to Cloudinary, return secure_url
 *     • anything else / missing   → write to public/uploads (existing behavior)
 *
 * Safety rules baked in here:
 *   - Default is LOCAL. Cloudinary activates ONLY when MEDIA_STORAGE=cloudinary
 *     is explicitly set AND credentials are present. If the flag says cloudinary
 *     but credentials are missing, we fall back to local rather than break uploads.
 *   - Media URLs are stored as plain strings (no parallel asset-map). Deletion
 *     derives the public_id from the stored Cloudinary URL (see publicIdFromUrl).
 *
 * Required env (production only — not needed for local mode):
 *   MEDIA_STORAGE=cloudinary
 *   CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
 *     …or the discrete trio:
 *   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { v2 as cloudinary } from "cloudinary";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { saveMediaR2, destroyByUrlR2, isR2Url, isR2Configured, categoryFor } from "./r2.js";

// ── Config ────────────────────────────────────────────────────────────────────

let _configured = false;

/** Lazily configure the SDK from env. Only called on the Cloudinary path. */
function ensureConfig() {
  if (_configured) return;
  if (process.env.CLOUDINARY_URL) {
    // The SDK auto-parses CLOUDINARY_URL; we only force https delivery.
    cloudinary.config({ secure: true });
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure:     true,
    });
  }
  _configured = true;
}

/** 'r2' | 'cloudinary' when explicitly enabled; every other value → 'local'. */
export function storageMode() {
  const v = String(process.env.MEDIA_STORAGE || "").trim().toLowerCase();
  if (v === "r2") return "r2";
  if (v === "cloudinary") return "cloudinary";
  return "local";
}

/** True when enough credentials exist to talk to Cloudinary. */
export function isCloudinaryConfigured() {
  return Boolean(process.env.CLOUDINARY_URL) ||
    Boolean(
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** basename without directory or extension — used as a deterministic public_id. */
function baseNameNoExt(filename) {
  const base = path.basename(String(filename || ""));
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** decodeURIComponent that returns null (not throws) on malformed input. */
function safeDecode(seg) {
  try { return decodeURIComponent(seg); }
  catch { return null; }
}

/**
 * A Cloudinary transformation path segment (e.g. "f_auto,q_auto,w_600" or
 * "t_named"). Folder/filename segments in our uploads never match this shape
 * (no "xx_value" tokens), so this is safe to strip.
 */
function isTransformationSegment(seg) {
  if (!seg) return false;
  return seg.split(",").every((tok) => /^[a-z]{1,3}_[^/]+$/i.test(tok));
}

// ── publicIdFromUrl ───────────────────────────────────────────────────────────
/**
 * Parse a Cloudinary delivery URL into { publicId, resourceType }.
 *
 * Handles URLs produced by this service:
 *   https://res.cloudinary.com/<cloud>/<rtype>/<dtype>/[<transforms>/][v<ver>/]<public_id>.<ext>
 *
 * Rules (per spec):
 *   - remove transformation segments, version (v123…), and the file extension
 *   - URL-decode each segment safely
 *   - return null for non-Cloudinary or malformed URLs (caller must NOT destroy)
 *
 * @param {string} url
 * @returns {{ publicId: string, resourceType: 'image'|'video'|'raw' } | null}
 */
export function publicIdFromUrl(url) {
  try {
    if (!url || typeof url !== "string") return null;

    let u;
    try { u = new URL(url); } catch { return null; }

    // Only our own Cloudinary delivery host.
    if (u.hostname !== "res.cloudinary.com") return null;

    // Decode each path segment; bail if any segment is malformed.
    const rawParts = u.pathname.split("/").filter(Boolean);
    const parts = rawParts.map(safeDecode);
    if (parts.some((p) => p === null)) return null;

    // [cloud_name, resource_type, delivery_type, ...rest]
    if (parts.length < 4) return null;
    const resourceType = parts[1];
    const deliveryType = parts[2];
    const rest = parts.slice(3);

    if (!["image", "video", "raw"].includes(resourceType)) return null;
    if (!["upload", "private", "authenticated"].includes(deliveryType)) return null;

    // Strip leading transformation segments (keep at least the public_id).
    while (rest.length > 1 && isTransformationSegment(rest[0])) rest.shift();

    // Strip a single version segment: v followed by digits.
    if (rest.length > 1 && /^v\d+$/.test(rest[0])) rest.shift();

    if (rest.length === 0) return null;

    // Strip the extension from the final segment; keep folder slashes intact.
    const last = rest[rest.length - 1];
    const dot = last.lastIndexOf(".");
    rest[rest.length - 1] = dot > 0 ? last.slice(0, dot) : last;

    const publicId = rest.join("/");
    if (!publicId) return null;

    return { publicId, resourceType };
  } catch {
    return null;
  }
}

// ── Upload ────────────────────────────────────────────────────────────────────

const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Upload a Buffer to Cloudinary with retry + timeout. Returns the raw SDK result.
 *
 * @param {object}  o
 * @param {Buffer}  o.buffer
 * @param {string}  o.folder        e.g. 'shopgold/uploads'
 * @param {'image'|'video'} o.resourceType
 * @param {string}  o.publicId      deterministic id (no extension)
 * @param {number} [o.timeout]
 */
export async function uploadBuffer({ buffer, folder, resourceType = "image", publicId, timeout = UPLOAD_TIMEOUT_MS }) {
  ensureConfig();

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type:    resourceType,
            public_id:        publicId,
            overwrite:        false, // idempotent: re-upload of same id is a no-op
            unique_filename:  false,
            use_filename:     false,
            invalidate:       true,
            timeout,
          },
          (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.on("error", reject);
        stream.end(buffer);
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

// ── saveMedia facade ──────────────────────────────────────────────────────────
/**
 * Persist a media buffer and return a URL string.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string} opts.filename       final on-disk name / public_id source (e.g. "1699-photo.jpg")
 * @param {string} opts.folder         Cloudinary folder (e.g. 'shopgold/uploads')
 * @param {'image'|'video'} [opts.resourceType='image']
 * @param {string} [opts.subdir='']    local sub-folder under public/uploads (e.g. 'receipts')
 * @param {string} [opts.contentType]  explicit Content-Type for R2 (default: from the filename extension)
 * @returns {Promise<{ storage:'local'|'cloudinary', url:string, filename?:string,
 *                     publicId?:string, resourceType?:string, width?:number,
 *                     height?:number, bytes?:number, format?:string }>}
 */
export async function saveMedia(buffer, opts = {}) {
  const { filename, folder, resourceType = "image", subdir = "", deterministic = false, category, contentType } = opts;
  const mode = storageMode();

  // ── R2 (production backend) ──────────────────────────────────────────────
  if (mode === "r2") {
    if (!isR2Configured()) {
      // Fail safe: never break an upload, and NEVER silently use Cloudinary.
      // Documented fallback: incomplete R2 config → LOCAL storage (public/uploads).
      console.error("[storage] MEDIA_STORAGE=r2 but R2 configuration is incomplete — falling back to LOCAL storage (never Cloudinary).");
      return saveLocal(buffer, filename, subdir);
    }
    return saveMediaR2(buffer, {
      filename,
      category: category || categoryFor(folder, resourceType),
      resourceType,
      deterministic,
      contentType,
    });
  }

  // ── Cloudinary (legacy; kept for partially-migrated assets, not for prod) ──
  if (mode === "cloudinary") {
    if (!isCloudinaryConfigured()) {
      console.warn("[cloudinary] MEDIA_STORAGE=cloudinary but no credentials found — falling back to local storage.");
      return saveLocal(buffer, filename, subdir);
    }
    const res = await uploadBuffer({ buffer, folder, resourceType, publicId: baseNameNoExt(filename) });
    return {
      storage:      "cloudinary",
      url:          res.secure_url,
      publicId:     res.public_id,
      resourceType: res.resource_type,
      width:        res.width,
      height:       res.height,
      bytes:        res.bytes,
      format:       res.format,
    };
  }

  // ── Local (default) ──────────────────────────────────────────────────────
  return saveLocal(buffer, filename, subdir);
}

/** Existing local behavior: write to public/uploads[/subdir] and return /uploads URL. */
async function saveLocal(buffer, filename, subdir = "") {
  const uploadDir = path.join(process.cwd(), "public", "uploads", subdir || "");
  if (!existsSync(uploadDir)) await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, filename), buffer);
  const url = "/uploads/" + (subdir ? `${subdir}/` : "") + filename;
  return { storage: "local", url, filename, localDir: uploadDir };
}

// ── Deletion (storage-aware dispatcher) ────────────────────────────────────────
/**
 * Delete a stored asset by its URL. Dispatches by URL:
 *   - R2 URL (belongs to R2_PUBLIC_URL)   → DeleteObject (only within R2_PREFIX)
 *   - Cloudinary URL (partial migration)  → Cloudinary destroy
 *   - local /uploads/ or external URL     → skipped safely (never throws)
 * Never deletes objects from another bucket/host.
 */
export async function destroyByUrl(url) {
  if (typeof url !== "string" || !url) return { ok: false, skipped: true, reason: "empty-url" };

  // R2 first (only matches when the URL host equals R2_PUBLIC_URL).
  if (isR2Url(url)) return destroyByUrlR2(url);

  // Cloudinary (existing partially-migrated assets).
  const parsed = publicIdFromUrl(url);
  if (parsed) {
    ensureConfig();
    try {
      const res = await cloudinary.uploader.destroy(parsed.publicId, {
        resource_type: parsed.resourceType,
        invalidate:    true,
      });
      return { ok: res.result === "ok" || res.result === "not found", storage: "cloudinary", result: res.result, publicId: parsed.publicId };
    } catch (err) {
      return { ok: false, storage: "cloudinary", error: err?.message || String(err), publicId: parsed.publicId };
    }
  }

  // Local / external → skip.
  const reason = url.startsWith("/uploads/") || url.includes("/uploads/") ? "local-url" : "external-url";
  return { ok: false, skipped: true, reason };
}

// ── Connection test (read-only; does not change storage) ──────────────────────
export async function verifyConnection() {
  ensureConfig();
  return cloudinary.api.ping(); // { status: 'ok' }
}
