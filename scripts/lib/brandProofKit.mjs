/**
 * scripts/lib/brandProofKit.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Test helpers for "Create Your Own Brand" payment proofs: an in-memory proof
 * storage (same interface as brandPaymentService.defaultProofStorage, real
 * upload validation), test file bytes, and "pay then accept" — the ONLY way an
 * access becomes ACTIVE.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { validateDepositUpload } from '../../src/lib/depositStorage.js';
import { submitPaymentProof, adminAcceptProof } from '../../src/lib/services/brandPaymentService.js';

/** In-memory private storage; `failStore` simulates a storage failure. */
export function makeProofStorage({ failStore = false } = {}) {
  const files = new Map();
  let n = 0;
  return {
    files,
    removed: [],
    validate: validateDepositUpload,
    async store(buffer) {
      if (failStore) throw new Error('disk full');
      const key = `proof-${++n}.jpg`;
      files.set(key, Buffer.from(buffer));
      return key;
    },
    async read(key) { return files.has(key) ? { buffer: files.get(key), contentType: 'image/jpeg' } : null; },
    async remove(key) { this.removed.push(key); return files.delete(key); },
  };
}

/** Distinct PNG-signed bytes per tag (distinct SHA-256 fingerprints). */
export const pngBytes = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.from(String(tag))]);

export const proofInput = (tag, { ref = `VIR-${tag}`, method = 'Virement bancaire', mime = 'image/png' } = {}) => {
  const buffer = pngBytes(tag);
  return { paymentMethod: method, transferReference: ref, proof: { buffer, mime, size: buffer.length } };
};

/** Submit a proof for the affiliate's request, then accept it as an admin → the access is ACTIVE. */
export async function payAndAccept(db, affiliateId, accessId, { tag = accessId, ref, actorId = 'admin-1', now, storage = makeProofStorage() } = {}) {
  await submitPaymentProof(affiliateId, accessId, proofInput(tag, ref ? { ref } : {}), { db, storage });
  return adminAcceptProof(accessId, { actorId, db, now });
}
