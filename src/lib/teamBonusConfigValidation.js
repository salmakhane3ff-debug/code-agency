/**
 * src/lib/teamBonusConfigValidation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side validation of POST /api/admin/team-bonus-config.
 *
 *   requiredActiveAffiliates  required, integer ≥ 1
 *   bonusAmount               required, number (unchanged rule)
 *   commissionTiers           required, non-empty array (unchanged rule)
 *   ugcGoal                   optional, integer ≥ 0 (0 = UGC goal hidden)
 *   securityDepositAmount     optional, number > 0
 *
 * Optional keys that are absent (or null) are left out of the patch, so the
 * stored value is kept by the merge save. Unknown keys are never forwarded.
 * Returns { ok: true, patch } or { ok: false, field, error }.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fail = (field, error) => ({ ok: false, field, error });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function validateTeamBonusConfigInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(null, 'Données invalides');
  }
  const { requiredActiveAffiliates, bonusAmount, commissionTiers, ugcGoal, securityDepositAmount } = body;

  if (!Number.isInteger(requiredActiveAffiliates) || requiredActiveAffiliates < 1) {
    return fail('requiredActiveAffiliates', 'Affiliés actifs requis : un nombre entier supérieur ou égal à 1.');
  }
  if (!isNum(bonusAmount)) {
    return fail('bonusAmount', 'Montant du bonus : un nombre est requis.');
  }
  if (!Array.isArray(commissionTiers) || commissionTiers.length === 0) {
    return fail('commissionTiers', 'Au moins un palier de commission est requis.');
  }

  const patch = { requiredActiveAffiliates, bonusAmount, commissionTiers };

  if (ugcGoal !== undefined && ugcGoal !== null) {
    if (!Number.isInteger(ugcGoal) || ugcGoal < 0) {
      return fail('ugcGoal', 'Objectif UGC : un nombre entier supérieur ou égal à 0 (0 = masqué).');
    }
    patch.ugcGoal = ugcGoal;
  }
  if (securityDepositAmount !== undefined && securityDepositAmount !== null) {
    if (!isNum(securityDepositAmount) || securityDepositAmount <= 0) {
      return fail('securityDepositAmount', 'Montant du dépôt de solde : un montant strictement positif est requis.');
    }
    patch.securityDepositAmount = securityDepositAmount;
  }

  return { ok: true, patch };
}
