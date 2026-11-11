/**
 * src/lib/demoCompetition/media.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Competition images: a member's profile photo and a brand's product image.
 * Validates the upload (declared type AND magic bytes, size), re-encodes it with
 * sharp (EXIF-rotated, square crop, WebP — the original file is never stored) and
 * persists it through the existing saveMedia facade with a real file name.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from 'node:crypto';

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

export const IMAGE_SPECS = Object.freeze({
  member: { size: 512, quality: 82, folder: 'demo-competition/avatars', subdir: 'demo-competition' },
  brand: { size: 640, quality: 84, folder: 'demo-competition/products', subdir: 'demo-competition' },
});

/** JPEG / PNG / WebP by magic bytes (never trust the declared type alone). */
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Validation only (no I/O): { ok } or { ok:false, code }. */
export function checkImageUpload({ type, size, buffer }) {
  if (!ACCEPTED_TYPES.has(String(type || '').toLowerCase())) return { ok: false, code: 'INVALID_IMAGE_TYPE' };
  if (!(size > 0)) return { ok: false, code: 'EMPTY_IMAGE' };
  if (size > IMAGE_MAX_BYTES) return { ok: false, code: 'IMAGE_TOO_LARGE' };
  if (buffer && !sniffImageType(buffer)) return { ok: false, code: 'INVALID_IMAGE_TYPE' };
  return { ok: true };
}

/** Re-encode to a square WebP (cover, attention crop). */
export async function processImage(buffer, kind) {
  const spec = IMAGE_SPECS[kind];
  if (!spec) throw Object.assign(new Error('bad kind'), { code: 'INVALID_INPUT' });
  const { default: sharp } = await import('sharp');
  try {
    return await sharp(buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(spec.size, spec.size, { fit: 'cover', position: 'attention' })
      .webp({ quality: spec.quality })
      .toBuffer();
  } catch {
    throw Object.assign(new Error('unreadable image'), { code: 'INVALID_IMAGE_TYPE' });
  }
}

/** Validate, process and store one image; returns its public URL. */
export async function storeDemoImage(file, kind, { save } = {}) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const check = checkImageUpload({ type: file.type, size: buffer.length, buffer });
  if (!check.ok) throw Object.assign(new Error(check.code), { code: check.code });
  const out = await processImage(buffer, kind);
  const spec = IMAGE_SPECS[kind];
  const saveMedia = save ?? (await import('../cloudinary.js')).saveMedia;
  const res = await saveMedia(out, { filename: `${kind}-${randomUUID()}.webp`, folder: spec.folder, subdir: spec.subdir, resourceType: 'image' });
  return res.url;
}
