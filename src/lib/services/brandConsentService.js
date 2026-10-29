/**
 * src/lib/services/brandConsentService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — refund-terms CONSENT primitives (server only).
 *
 *   • termsTextSha256 — the one fingerprint: SHA-256 of the exact stored text's
 *     UTF-8 bytes, lowercase hex, no Unicode normalization (the database checks
 *     the same value with encode(sha256(convert_to(text,'UTF8')),'hex'))
 *   • immutable published versions (brand_terms_versions) are the reference:
 *     a request's ORIGINAL consent verifies only if its snapshot (version, exact
 *     text, strict UTC acceptance time) and fingerprint match its own version —
 *     a newer published version never invalidates it
 *   • fresh consents (brand_access_consents) are separate evidence: they never
 *     authorize payment; a REOPEN_RENEWAL to the latest version allows reopening
 *     a CLOSED request whose original consent cannot be verified
 *   • legacy integrity diagnostics are informational only — they never make a
 *     request payable
 *
 * Mirrors brand_original_consent_ok() and the triggers of migration 20261030.
 * Nothing here writes; recording a fresh consent is brandAccessService's job.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'crypto';
import prisma from '../prisma.js';
import { packageBreakdown } from '../brandPricing.js';
import { normalizeBrandName, isValidClientRequestId } from '../brandProgram.js';

/** Advisory-lock key: publishing takes it exclusively; requests, renewals and reopenings share it. */
export const TERMS_LOCK_KEY = 'brand-terms';
export const CONSENT = Object.freeze({ VERIFIED: 'VERIFIED', UNVERIFIABLE: 'UNVERIFIABLE' });
export const CONSENT_CONTEXT = Object.freeze({ PENDING_RENEWAL: 'PENDING_RENEWAL', REOPEN_RENEWAL: 'REOPEN_RENEWAL' });

const err = (code, message) => Object.assign(new Error(message), { code });
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const termsTextSha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

/** Strict UTC timestamp ('YYYY-MM-DDTHH:MM:SS[.ffffff]Z', a real calendar date) — same rule as brand_iso_ts(). */
export function isStrictUtcTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** The latest published (immutable) terms version, or null. */
export function getPublishedTermsVersion(db = prisma) {
  return db.brandTermsVersion.findFirst({ orderBy: { version: 'desc' } });
}

/** VERIFIED only when the request's original snapshot matches its own immutable version exactly. */
export function classifyConsent(access, versionRow) {
  const s = access?.termsSnapshot;
  if (!versionRow || !isObj(s)) return CONSENT.UNVERIFIABLE;
  if (!Number.isInteger(s.version) || s.version !== access.termsVersion || versionRow.version !== access.termsVersion) return CONSENT.UNVERIFIABLE;
  if (typeof s.text !== 'string' || s.text !== versionRow.text) return CONSENT.UNVERIFIABLE;
  if (!isStrictUtcTimestamp(s.acceptedAt)) return CONSENT.UNVERIFIABLE;
  if (access.termsTextSha256 != null && access.termsTextSha256 !== versionRow.textSha256) return CONSENT.UNVERIFIABLE;
  return CONSENT.VERIFIED;
}

export async function originalConsent(db, access) {
  const versionRow = await db.brandTermsVersion.findUnique({ where: { version: access.termsVersion } });
  return classifyConsent(access, versionRow);
}

/** Payment gate: the request's OWN original consent (fresh consents never count). @throws CONSENT_UNVERIFIED */
export async function assertOriginalConsent(db, access) {
  if ((await originalConsent(db, access)) !== CONSENT.VERIFIED) {
    throw err('CONSENT_UNVERIFIED', 'Les conditions acceptées pour cette demande ne peuvent pas être vérifiées : le paiement est indisponible.');
  }
}

/**
 * Reopening a CLOSED request: verified original consent, or a REOPEN_RENEWAL
 * consent to the LATEST published version (call under the terms lock).
 * @returns {{ basis: 'ORIGINAL' } | { basis: 'RENEWAL', consentId }}  @throws CONSENT_RENEWAL_REQUIRED
 */
export async function consentForReopen(tx, access) {
  if ((await originalConsent(tx, access)) === CONSENT.VERIFIED) return { basis: 'ORIGINAL' };
  const latest = await getPublishedTermsVersion(tx);
  const renewal = latest ? await tx.brandAccessConsent.findFirst({
    where: { accessId: access.id, context: CONSENT_CONTEXT.REOPEN_RENEWAL, termsVersion: latest.version, termsTextSha256: latest.textSha256 },
    orderBy: { acceptedAt: 'desc' },
  }) : null;
  if (!renewal) throw err('CONSENT_RENEWAL_REQUIRED', 'Le participant doit d’abord accepter les conditions actuellement publiées.');
  return { basis: 'RENEWAL', consentId: renewal.id };
}

/**
 * Read-only integrity diagnostics of a legacy request (informational for the
 * admin — passing them NEVER authorizes payment: which terms govern a request
 * whose original consent cannot be verified is an open business decision).
 */
export function assessLegacyIntegrity(row, { versionRow = null, authorization = null, hasProof = false } = {}) {
  const pkg = isObj(row.packageSnapshot) ? row.packageSnapshot : {};
  const total = isObj(pkg.breakdown) ? Number(pkg.breakdown.total) : NaN;
  let recomputed = null;
  try { recomputed = packageBreakdown(pkg); } catch { recomputed = null; }
  const products = Array.isArray(row.selectedProducts) ? row.selectedProducts : null;
  const ids = products ? products.map((p) => (isObj(p) ? p.id : null)) : [];
  const checks = {
    amountMatchesSnapshot: Number.isFinite(total) && Number(row.amount) === total,
    breakdownRecomputes: !!recomputed && Number.isFinite(total) && recomputed.total === total,
    productsValid: !!products && products.length >= 3 && products.length <= 4
      && ids.every((id) => typeof id === 'string' && id) && new Set(ids).size === ids.length,
    brandNameValid: normalizeBrandName(row.brandName) === row.brandName,
    requestIdValid: isValidClientRequestId(row.clientRequestId),
    authorizationConsistent: !row.authorizationId || authorization?.consumedByAccessId === row.id,
    noProof: !hasProof,
    termsVersionExists: !!versionRow,
    termsSnapshotShape: isObj(row.termsSnapshot) && typeof row.termsSnapshot.text === 'string'
      && Number.isInteger(row.termsSnapshot.version),
  };
  return { checks, allPassed: Object.values(checks).every(Boolean), authorizesPayment: false };
}

// ── Database guard errors (migration 20261030) → domain errors ─────────────────
// Trigger errors reach the app only as text inside the error message, in two
// observed shapes: ORM queries `… code: "BRC01", message: "brand_accesses: …"`
// and raw queries ``Raw query failed. Code: `BRC02`. Message: `ERROR: …` ``.
// The match is narrow: the exact message prefix, plus the SQLSTATE when shown.
const DB_ERRORS = [
  { sqlState: 'BRC01', prefix: 'brand_accesses: consent does not match an immutable published terms version', code: 'CONSENT_UNVERIFIED' },
  { sqlState: 'BRC02', prefix: 'brand_accesses: activation requires verified original consent', code: 'CONSENT_UNVERIFIED' },
  { sqlState: 'BRC02', prefix: 'brand_payment_proofs: payment requires verified original consent', code: 'CONSENT_UNVERIFIED' },
  { sqlState: 'BRC03', prefix: 'brand_accesses: reopening requires verified original consent or a renewal to the latest terms', code: 'CONSENT_RENEWAL_REQUIRED' },
  { sqlState: 'BRC04', prefix: 'brand_access_consents: a fresh consent is not allowed for this request or terms version', code: 'CONSENT_NOT_REQUIRED' },
  { sqlState: 'BRP01', prefix: 'brand_payment_proofs: a proof is submitted only for a request awaiting payment', code: 'NOT_PENDING' },
];

export function isBrandDbError(e, sqlState, prefix) {
  const msg = typeof e?.message === 'string' ? e.message : '';
  if (!msg.includes(prefix)) return false;
  const shown = msg.match(/code: "([0-9A-Z]{5})"/) || msg.match(/Code: `([0-9A-Z]{5})`/);
  return !shown || shown[1] === sqlState;
}

/** The domain error code for a recognised brand guard error, else null (the caller re-throws). */
export function brandDbErrorCode(e) {
  const hit = DB_ERRORS.find((d) => isBrandDbError(e, d.sqlState, d.prefix));
  return hit ? hit.code : null;
}
