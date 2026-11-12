/**
 * src/lib/neutralWording.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Neutral wording of the active "Create Your Own Brand" dashboard (src/app/affiliate/dashboard/_brand/*) —
 * TEMPORARY DESIGN-REVIEW PREVIEW, TEXT ONLY.
 *
 * While NEUTRAL_WORDING_PREVIEW is true, the visible "simulation"-type labels, badges and disclaimers of that
 * dashboard are replaced by neutral labels (or not shown), including the "training orders" note and the "SIM-"
 * prefix of the DISPLAYED order references (the reference values themselves are unchanged). Every component,
 * number, chart, API call and polling stays exactly as it is. The Brand OFFER / purchase terms keep their texts.
 *
 * ⚠ Not for publication (Brand dashboard): simulated activity shown to real users needs its disclosure.
 * To restore every original Brand dashboard label, set NEUTRAL_WORDING_PREVIEW to false (one switch).
 *
 * Top Members / Top Brands (affiliate dashboard block, /top-members, /top-brands, profiles) are NOT handled here
 * any more: their texts are neutral at the source (src/lib/demoCompetition/i18n.js) and their simulation disclosure
 * is defined in ONE place, src/lib/demoCompetition/disclosure.js (shown by <SimulationNote>; change or disable it there).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const NEUTRAL_WORDING_PREVIEW = true;

const interpolate = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s);

/** Wrap a translator `t(key, vars)`: keys present in `overrides` get the neutral text ("" = not shown). */
export function neutralize(t, overrides) {
  if (!NEUTRAL_WORDING_PREVIEW || !overrides) return t;
  return (key, vars) => (Object.prototype.hasOwnProperty.call(overrides, key) ? interpolate(overrides[key], vars) : t(key, vars));
}

/** Active / closed "Create Your Own Brand" dashboard — brandI18n keys (t). */
export const BRAND_DASH_NEUTRAL = Object.freeze({
  fr: Object.freeze({
    dash_badge: "", dash_disclaimer: "",
    starts_on: "Démarrage le {date}.", paused: "En pause.",
    total_orders: "Commandes", chart_hour: "Commandes par heure", chart_day: "Commandes par jour",
    no_data: "Aucune donnée sur cette période.", chart_aria: "Commandes",
    recent_title: "Dernières commandes", recent_empty: "Aucune commande pour le moment.",
    closed_readonly: "L'historique reste consultable en lecture seule.",
    recent_note: "",
  }),
  ar: Object.freeze({
    dash_badge: "", dash_disclaimer: "",
    starts_on: "يبدأ في {date}.", paused: "متوقف مؤقتاً.",
    total_orders: "الطلبات", chart_hour: "الطلبات حسب الساعة", chart_day: "الطلبات حسب اليوم",
    no_data: "لا توجد بيانات في هذه الفترة.", chart_aria: "الطلبات",
    recent_title: "آخر الطلبات", recent_empty: "لا توجد طلبات بعد.",
    closed_readonly: "يبقى السجل متاحاً للاطلاع فقط.",
    recent_note: "",
  }),
});

/**
 * Order reference AS DISPLAYED on the active Brand dashboard: the "SIM-" prefix is not shown while the preview is on.
 * Display only — the reference itself (API value, React key, data-order attribute, paging) is never changed.
 */
export const displayOrderRef = (ref) => (NEUTRAL_WORDING_PREVIEW && typeof ref === "string" ? ref.replace(/^SIM-/, "") : ref);

/** Active / closed "Create Your Own Brand" dashboard — dashboardText keys (d). */
export const BRAND_DASH_TEXT_NEUTRAL = Object.freeze({
  fr: Object.freeze({
    hero_subtitle: "Lancez une marque e-commerce en toute simplicité.",
    sim_tag: "", fin_note: "",
    fin_balance: "Solde", fin_profit: "Profit net", fin_revenue: "Chiffre d'affaires",
    fin_no_price: "Prix de vente non défini pour cette demande : aucun chiffre n'est calculé.",
    fin_price: "Prix de vente", fin_expenses: "Frais", fin_net: "Profit net",
    fin_no_amount: "Aucun montant : cette commande n'a pas abouti, rien n'est réalisé.",
    all_title: "Toutes les commandes",
  }),
  ar: Object.freeze({
    hero_subtitle: "أطلق علامة تجارية للتجارة الإلكترونية بكل سهولة.",
    sim_tag: "", fin_note: "",
    fin_balance: "الرصيد", fin_profit: "الأرباح", fin_revenue: "إجمالي رقم المعاملات",
    fin_no_price: "ثمن البيع غير محدد لهذا الطلب: لا يتم احتساب أي رقم.",
    fin_price: "ثمن البيع", fin_expenses: "المصاريف", fin_net: "الربح الصافي",
    fin_no_amount: "لا يوجد أي مبلغ: هذا الطلب لم يكتمل، لا شيء محقق.",
    all_title: "كل الطلبات",
  }),
});
