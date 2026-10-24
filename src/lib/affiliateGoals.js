/**
 * src/lib/affiliateGoals.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Dashboard progression goals (orders, valid referrals, UGC videos) — display
 * only; no payout, bonus or eligibility rule reads these.
 *
 *   0                    → goal HIDDEN (row not rendered, no division)
 *   integer > 0          → that target, as before
 *   missing / null       → the existing default (fallback)
 *   negative / invalid   → treated as missing (defensive read; the admin API
 *                          rejects negatives at save time)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const INVALID_GOAL = 'INVALID_GOAL';

/** → { hidden: true } | { hidden: false, target } */
export function resolveGoal(value, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (n === 0) return { hidden: true, target: 0 };
  if (Number.isInteger(n) && n > 0) return { hidden: false, target: n };
  return { hidden: false, target: fallback };
}

/** Bar width in % (0–100) for a visible goal. */
export function goalPercent(current, target) {
  const t = Number(target);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Math.min(100, ((Number(current) || 0) / t) * 100));
}

/**
 * Admin input for a per-affiliate goal. Keeps the existing rule (empty or
 * non-numeric → null = dashboard default) and adds: negatives are refused.
 * Throws { code: INVALID_GOAL } with a user-facing message.
 */
export function parseGoalInput(value, label) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) return null;
  if (n < 0) {
    throw Object.assign(
      new Error(`${label} : la valeur ne peut pas être négative (0 = masqué, vide = par défaut).`),
      { code: INVALID_GOAL },
    );
  }
  return n === 0 ? 0 : n; // "-0" → 0
}
