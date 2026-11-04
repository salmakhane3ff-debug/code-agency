/**
 * src/lib/paymentProofStorage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * PRIVATE storage for affiliate payment-proof receipt images — same architecture
 * as deposit / identity documents: private_uploads (outside public/, never a
 * /uploads URL), streamed only by authorized routes that re-check visibility.
 *
 *   • images only: JPEG, PNG, WebP; ≤ 8 MB; declared type AND magic bytes
 *   • re-encoded through sharp to a normalized JPEG (strips EXIF/GPS metadata)
 *   • crypto-random keys, never derived from client input; traversal-safe reads
 *   • fingerprint = SHA-256 of the ORIGINAL bytes (duplicate-receipt detection)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID, createHash } from 'crypto';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { sniffKind } from './depositStorage.js';

export const PROOF_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
export const PROOF_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const PROOF_DIR = path.join(process.cwd(), 'private_uploads', 'payment-proofs');
const KEY_RE = /^[a-f0-9-]{36}\.jpg$/;

const fileError = (message) => Object.assign(new Error(message), { code: 'INVALID_FILE' });

/** Backend-authoritative declared type + size check → list of problems ([] = ok). */
export function validateProofImage({ mime, size } = {}) {
  const errors = [];
  if (!PROOF_IMAGE_TYPES.includes(String(mime || '').toLowerCase())) errors.push('type');
  if (!Number.isFinite(size) || size <= 0 || size > PROOF_IMAGE_MAX_BYTES) errors.push('size');
  return errors;
}

export const fingerprintOf = (buffer) => createHash('sha256').update(buffer).digest('hex');

function resolveKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  const root = path.resolve(PROOF_DIR);
  const abs = path.resolve(root, key);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/** The default (disk) storage. Tests inject an in-memory one with the same interface. */
export const defaultPaymentProofStorage = {
  validate: validateProofImage,
  /** Verify magic bytes, re-encode, store. → { key, fingerprint }. Throws INVALID_FILE. */
  async store(buffer) {
    const kind = sniffKind(buffer);
    if (!['jpeg', 'png', 'webp'].includes(kind)) throw fileError('Image non supportée ou corrompue.');
    let out;
    try {
      const { default: sharp } = await import('sharp');
      out = await sharp(buffer).rotate().resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    } catch {
      throw fileError('Image invalide.');
    }
    if (!existsSync(PROOF_DIR)) await mkdir(PROOF_DIR, { recursive: true });
    const key = `${randomUUID()}.jpg`;
    await writeFile(path.join(PROOF_DIR, key), out, { flag: 'wx' });
    return { key, fingerprint: fingerprintOf(buffer) };
  },
  async exists(key) {
    const abs = resolveKey(key);
    return !!abs && existsSync(abs);
  },
  async read(key) {
    const abs = resolveKey(key);
    if (!abs || !existsSync(abs)) return null;
    return { buffer: await readFile(abs), contentType: 'image/jpeg' };
  },
  async remove(key) {
    const abs = resolveKey(key);
    if (!abs || !existsSync(abs)) return false;
    try { await unlink(abs); return true; } catch { return false; }
  },
};
