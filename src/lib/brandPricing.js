/**
 * src/lib/brandPricing.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — package price breakdown. PURE (no DB, no I/O),
 * shared by the server (request snapshot), the admin preview and the affiliate
 * view, so every screen shows the same figures.
 *
 * Every value comes from the admin configuration; nothing is assumed here.
 * Rules (decided by the business owner):
 *   subtotal = package price + delivery cost + logistics cost
 *   VAT      = subtotal × VAT %
 *   total    = subtotal + VAT            ← the amount the participant pays
 *   Confirmation %, advertising % and company share % are INFORMATIONAL lines:
 *   each is applied to the calculation base the admin chose for it and is
 *   NEVER added to the total (no double counting).
 * Amounts are computed in integer centimes (half-up at each line).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Calculation bases an admin can choose for an informational percentage. */
export const PERCENT_BASES = Object.freeze({
  PACKAGE_PRICE:    'PACKAGE_PRICE',    // package price only
  SUBTOTAL:         'SUBTOTAL',         // price + delivery + logistics (before VAT)
  TOTAL_WITH_VAT:   'TOTAL_WITH_VAT',   // the amount paid
  SIMULATED_ORDERS: 'SIMULATED_ORDERS', // a rate over simulated training orders (no amount)
});
export const PERCENT_KEYS = Object.freeze(['confirmation', 'advertising', 'companyShare']);
export const MONEY_BASES = Object.freeze([PERCENT_BASES.PACKAGE_PRICE, PERCENT_BASES.SUBTOTAL, PERCENT_BASES.TOTAL_WITH_VAT]);

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;
/** pct may have 2 decimals: work in hundredths of a percent → exact integer maths. */
const pctOf = (cents, pct) => Math.round((cents * Math.round(Number(pct) * 100)) / 10000);

/** Fields a package must have before it can be offered (null = not configured). */
export function missingPricingFields(p) {
  const miss = [];
  for (const k of ['price', 'deliveryCost', 'logisticsCost', 'vatPercent', 'productCount']) {
    if (p?.[k] === null || p?.[k] === undefined || p?.[k] === '' || Number.isNaN(p?.[k])) miss.push(k);
  }
  for (const k of PERCENT_KEYS) {
    const v = p?.percentages?.[k];
    if (!v || v.value === null || v.value === undefined || Number.isNaN(v.value)) miss.push(`percentages.${k}.value`);
    if (!v || !Object.values(PERCENT_BASES).includes(v.base)) miss.push(`percentages.${k}.base`);
  }
  return miss;
}

/**
 * Breakdown of a COMPLETE package (returns null if anything is missing).
 * { price, deliveryCost, logisticsCost, subtotal, vat: { percent, base, amount }, total,
 *   informational: [{ key, percent, base, baseAmount|null, amount|null }] }
 */
export function packageBreakdown(p) {
  if (!p || missingPricingFields(p).length) return null;
  const price = toCents(p.price), delivery = toCents(p.deliveryCost), logistics = toCents(p.logisticsCost);
  const subtotal = price + delivery + logistics;
  const vat = pctOf(subtotal, p.vatPercent);
  const total = subtotal + vat;
  const baseCents = { PACKAGE_PRICE: price, SUBTOTAL: subtotal, TOTAL_WITH_VAT: total };
  return {
    price: fromCents(price),
    deliveryCost: fromCents(delivery),
    logisticsCost: fromCents(logistics),
    subtotal: fromCents(subtotal),
    vat: { percent: Number(p.vatPercent), base: PERCENT_BASES.SUBTOTAL, amount: fromCents(vat) },
    total: fromCents(total),
    informational: PERCENT_KEYS.map((key) => {
      const { value, base } = p.percentages[key];
      const b = baseCents[base];
      return {
        key, percent: Number(value), base,
        baseAmount: b === undefined ? null : fromCents(b),
        amount: b === undefined ? null : fromCents(pctOf(b, value)),
        addedToTotal: false,
      };
    }),
  };
}
