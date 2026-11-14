/**
 * src/lib/payoutBanks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure rules of the bank logo picker (Phase 4). Shared by the server (authority) and
 * the affiliate / recruiter / admin pages (hints only). No I/O.
 *
 *   • The admin catalogue (payout_banks): name (1 … 80, unique whatever the case),
 *     public logo, active flag, "RIB required" flag, display order. Never deleted —
 *     a bank is DEACTIVATED.
 *   • A user's selection = { bankId, accountName, rib }:
 *       – bankId must name a bank of the catalogue. An INACTIVE bank is accepted ONLY
 *         when it is already the user's saved bank (existing users keep their choice,
 *         are never forced to re-select, and can still edit their holder details);
 *       – accountName (the account holder's full name) is ALWAYS required;
 *       – rib: required (10 … 34 letters / digits, spaces ignored) when the bank says
 *         "RIB required"; otherwise it is not asked for and is cleared.
 *     bankName is never typed: it is a copy of the chosen bank's name.
 *   • Withdrawal eligibility (validateBankInfo in affiliateSystemService) keeps the
 *     original rule and skips the RIB only when the chosen bank says ribRequired = false.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PAYOUT_BANK_LIMITS = Object.freeze({
  NAME_MAX: 80,
  HOLDER_MAX: 80,
  RIB_MIN: 10,
  RIB_MAX: 34,
  SORT_MAX: 9999,
  LOGO_MAX_BYTES: 2 * 1024 * 1024, // 2 MB (stricter than the generic 10 MB image cap)
});
/** Logo formats accepted by the admin upload (SVG is never accepted: scriptable). */
export const PAYOUT_BANK_LOGO_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const PAYOUT_BANK_LOGO_EXTS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);

/** Field codes returned by the server (400 INVALID_INPUT → { fields }). */
export const BANK_FIELD_CODES = Object.freeze({
  bankId: Object.freeze(['BANK_REQUIRED', 'BANK_UNAVAILABLE']),
  rib: Object.freeze(['INVALID_RIB']),
  accountName: Object.freeze(['INVALID_ACCOUNT_NAME']),
});

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isBankId = (v) => typeof v === 'string' && ID_RE.test(v);

/** Collapse whitespace + trim (text fields). Non-strings → ''. */
export const cleanBankText = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
/** RIB without any whitespace. Non-strings → ''. */
export const cleanRib = (v) => (typeof v === 'string' ? v.replace(/\s/g, '') : '');

/** RIB format: 10 … 34 letters / digits (after removing spaces). */
export const isValidRib = (rib) => {
  const r = cleanRib(rib);
  return r.length >= PAYOUT_BANK_LIMITS.RIB_MIN && r.length <= PAYOUT_BANK_LIMITS.RIB_MAX && /^[A-Za-z0-9]+$/.test(r);
};
/** Account holder's full name: 1 … 80 characters, no angle brackets. */
export const isValidHolder = (name) => {
  const n = cleanBankText(name);
  return n.length >= 1 && n.length <= PAYOUT_BANK_LIMITS.HOLDER_MAX && !/[<>]/.test(n);
};

/** What any signed-in user may see of a catalogue bank. */
export function bankPublicView(b) {
  if (!b || typeof b !== 'object') return null;
  return {
    id: String(b.id),
    name: String(b.name ?? ''),
    logoUrl: typeof b.logoUrl === 'string' && b.logoUrl ? b.logoUrl : null,
    isActive: b.isActive === true,
    ribRequired: b.ribRequired !== false,
  };
}

/**
 * The banks a user can pick: every ACTIVE bank (catalogue order), plus their current
 * bank when it has been deactivated since (shown, still selected, never offered to others).
 */
export function selectableBanks(activeBanks, currentBank) {
  const list = (Array.isArray(activeBanks) ? activeBanks : []).filter((b) => b && b.isActive !== false);
  const cur = currentBank && currentBank.id ? currentBank : null;
  if (cur && !list.some((b) => b.id === cur.id)) return [...list, cur];
  return list;
}

/**
 * Check a user's selection against the RESOLVED bank row.
 * @param {object} p
 * @param {*} p.bankId           the submitted bank id
 * @param {object|null} p.bank   the catalogue row for that id (null when not found)
 * @param {string|null} p.currentBankId  the user's saved bank id
 * @param {*} p.rib
 * @param {*} p.accountName
 * @returns {{ fields: object|null, data: { bankId, bankName, rib, accountName }|null }}
 */
export function checkBankSelection({ bankId, bank, currentBankId = null, rib, accountName } = {}) {
  const fields = {};
  let chosen = null;
  if (bankId === undefined || bankId === null || bankId === '') fields.bankId = 'BANK_REQUIRED';
  else if (!isBankId(bankId) || !bank || bank.id !== bankId) fields.bankId = 'BANK_UNAVAILABLE';
  else if (bank.isActive !== true && bank.id !== currentBankId) fields.bankId = 'BANK_UNAVAILABLE';
  else chosen = bank;

  if (!isValidHolder(accountName)) fields.accountName = 'INVALID_ACCOUNT_NAME';
  // The RIB rule follows the chosen bank; without a valid bank it cannot be decided yet,
  // so a RIB that was typed is still checked (one round-trip shows every problem).
  const ribRequired = chosen ? chosen.ribRequired !== false : cleanRib(rib) !== '';
  if (ribRequired && !isValidRib(rib)) fields.rib = 'INVALID_RIB';

  if (Object.keys(fields).length) return { fields, data: null };
  return {
    fields: null,
    data: {
      bankId: chosen.id,
      bankName: chosen.name,
      rib: chosen.ribRequired !== false ? cleanRib(rib) : null,
      accountName: cleanBankText(accountName),
    },
  };
}

/**
 * Client-side mirror of the withdrawal rule (the server decides): holder name always,
 * RIB 10 … 34 unless the chosen bank says ribRequired = false; a legacy row without a
 * catalogue bank keeps the original rule (bank name + holder + RIB).
 */
export function bankDetailsComplete({ bankName, accountName, rib, bank } = {}) {
  if (!String(bankName ?? '').trim() || !String(accountName ?? '').trim()) return false;
  if (bank && bank.ribRequired === false) return true;
  const r = String(rib ?? '').trim();
  return r.length >= PAYOUT_BANK_LIMITS.RIB_MIN && r.length <= PAYOUT_BANK_LIMITS.RIB_MAX;
}

/**
 * Admin form → { data } or { fields } (create: name required; update: partial).
 * Unknown keys → fields.body = 'UNKNOWN_FIELD'.
 */
export function parseAdminBankInput(input, { partial = false } = {}) {
  const fields = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fields: { body: 'INVALID_BODY' }, data: null };
  const allowed = ['name', 'isActive', 'ribRequired', 'sortOrder'];
  if (Object.keys(input).some((k) => !allowed.includes(k))) return { fields: { body: 'UNKNOWN_FIELD' }, data: null };
  const data = {};
  if (!partial || input.name !== undefined) {
    const name = cleanBankText(input.name);
    if (!name || name.length > PAYOUT_BANK_LIMITS.NAME_MAX || /[<>]/.test(name)) fields.name = 'INVALID_NAME';
    else data.name = name;
  }
  for (const k of ['isActive', 'ribRequired']) {
    if (input[k] === undefined) continue;
    if (typeof input[k] !== 'boolean') fields[k] = 'INVALID_FLAG';
    else data[k] = input[k];
  }
  if (input.sortOrder !== undefined) {
    const n = input.sortOrder;
    if (!Number.isInteger(n) || n < 0 || n > PAYOUT_BANK_LIMITS.SORT_MAX) fields.sortOrder = 'INVALID_SORT_ORDER';
    else data.sortOrder = n;
  }
  if (partial && !Object.keys(fields).length && !Object.keys(data).length) fields.body = 'EMPTY_UPDATE';
  return Object.keys(fields).length ? { fields, data: null } : { fields: null, data };
}

/** Logo file name extension (lower-case, with the dot). */
export const logoExt = (filename) => {
  const m = /\.[A-Za-z0-9]+$/.exec(String(filename ?? ''));
  return m ? m[0].toLowerCase() : '';
};
/** Pre-check of an admin logo file (type + extension + size); the server also checks the bytes. */
export function checkLogoFile({ type, name, size } = {}) {
  if (!PAYOUT_BANK_LOGO_TYPES.includes(type) || !PAYOUT_BANK_LOGO_EXTS.includes(logoExt(name))) return 'LOGO_TYPE';
  if (!Number.isFinite(size) || size <= 0) return 'LOGO_EMPTY';
  if (size > PAYOUT_BANK_LIMITS.LOGO_MAX_BYTES) return 'LOGO_TOO_LARGE';
  return null;
}
