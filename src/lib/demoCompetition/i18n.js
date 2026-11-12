/**
 * src/lib/demoCompetition/i18n.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Public Top Members / Top Brands texts in French and Arabic.
 * The pages follow the storefront language (useLanguage(): 'ar' | 'fr').
 * Both dictionaries MUST have the same keys — scripts/demoCompetitionPublic.test.mjs
 * enforces it, and that every key used by the UI exists.
 *
 * The leaderboard values are simulated: the texts must never present them as real
 * sales, real earnings or withdrawable money. The simulation disclosure itself is NOT
 * here — it lives in ONE place, src/lib/demoCompetition/disclosure.js (rendered by
 * <SimulationNote>), so it can be reworded or disabled safely.
 *
 * Also holds the pure display helpers (money, relative time, initials) so they
 * can be unit-tested without React.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fr = {
  community_title: "Les Leaders de la Communauté",
  banner_participants: "participants",
  banner_brands: "{n} marques",
  rolling_window: "classement 30 jours glissants",
  updates_live: "Mise à jour en direct",
  orders_short: "cmds",
  members_title: "Top Membres",
  brands_title: "Top Marques",
  members_subtitle: "Classement des membres selon leurs gains sur 30 jours glissants.",
  brands_subtitle: "Classement des marques selon leurs gains sur 30 jours glissants.",
  live: "En direct",
  live_title: "Activité au cours des 10 dernières minutes",
  rank_label: "Rang {rank}",
  rank_of: "Rang {rank} sur {total}",
  earnings_30d: "Gains (30 j)",
  orders_30d: "Commandes (30 j)",
  network_30d: "Réseau (30 j)",
  not_configured: "Non configuré",
  moved_up: "Monte de {n} place(s) depuis la dernière mise à jour",
  moved_down: "Descend de {n} place(s) depuis la dernière mise à jour",
  moved_up_24h: "Monte de {n} place(s) en 24 h",
  moved_down_24h: "Descend de {n} place(s) en 24 h",
  no_change_24h: "Même rang qu'il y a 24 h",
  new_entry: "Nouveau",
  view_all: "Voir tout",
  view_profile: "Voir le profil de {name}",
  owner_label: "Propriétaire",
  owner_by: "par {name}",
  loading: "Chargement…",
  error_load: "Impossible de charger les données pour le moment. Nouvel essai automatique…",
  error_stale: "Connexion interrompue : dernières valeurs affichées.",
  empty_members: "Aucun membre n'est affiché pour le moment.",
  empty_brands: "Aucune marque n'est affichée pour le moment.",
  leaderboard_members_label: "Classement Top Membres",
  leaderboard_brands_label: "Classement Top Marques",
  back_members: "Retour au Top Membres",
  back_brands: "Retour au Top Marques",
  not_found_member_title: "Profil introuvable",
  not_found_member_text: "Ce membre n'existe pas ou n'est plus affiché dans le classement.",
  not_found_brand_title: "Marque introuvable",
  not_found_brand_text: "Cette marque n'existe pas ou n'est plus affichée dans le classement.",
  stats_title: "Statistiques",
  period_24h: "24 h",
  period_7d: "7 jours",
  period_30d: "30 jours",
  period_all: "Depuis le début",
  total_orders: "Commandes (total)",
  personal_title: "Gains personnels",
  network_title: "Réseau d'affiliés",
  network_affiliates: "Affiliés",
  network_note: "Les gains du réseau sont comptés séparément des gains personnels et n'entrent pas dans le classement.",
  network_off: "Le réseau n'est pas configuré pour ce membre.",
  owned_brands: "Marques",
  no_brands: "Aucune marque.",
  history_title: "Historique sur 30 jours",
  history_label: "Gains par jour sur les 30 derniers jours",
  legend_personal: "Personnel",
  legend_network: "Réseau",
  legend_brand: "Marque",
  bar_title: "{day} · {label} : {amount} ({orders} cmd)",
  recent_title: "Activité récente",
  recent_empty: "Aucune activité récente.",
  event_PERSONAL_SALE: "Vente personnelle",
  event_NETWORK_SALE: "Vente du réseau",
  event_BRAND_SALE: "Vente de la marque",
  event_qty: "{n} commande(s)",
  time_now: "à l'instant",
  time_min: "il y a {n} min",
  time_h: "il y a {n} h",
  time_d: "il y a {n} j",
  photo_alt: "Photo de {name}",
  product_alt: "Produit de la marque {name}",
  currency: "DH",
};

const ar = {
  community_title: "قادة المجتمع",
  banner_participants: "مشاركاً",
  banner_brands: "{n} علامة تجارية",
  rolling_window: "ترتيب آخر 30 يوماً",
  updates_live: "تحديث مباشر",
  orders_short: "طلب",
  members_title: "أفضل الأعضاء",
  brands_title: "أفضل العلامات التجارية",
  members_subtitle: "ترتيب الأعضاء حسب الأرباح خلال آخر 30 يوماً.",
  brands_subtitle: "ترتيب العلامات التجارية حسب الأرباح خلال آخر 30 يوماً.",
  live: "مباشر",
  live_title: "نشاط خلال آخر 10 دقائق",
  rank_label: "المرتبة {rank}",
  rank_of: "المرتبة {rank} من {total}",
  earnings_30d: "الأرباح (30 يوماً)",
  orders_30d: "الطلبات (30 يوماً)",
  network_30d: "الشبكة (30 يوماً)",
  not_configured: "غير مُفعّل",
  moved_up: "تقدّم {n} مرتبة منذ آخر تحديث",
  moved_down: "تراجع {n} مرتبة منذ آخر تحديث",
  moved_up_24h: "تقدّم {n} مرتبة خلال 24 ساعة",
  moved_down_24h: "تراجع {n} مرتبة خلال 24 ساعة",
  no_change_24h: "نفس المرتبة قبل 24 ساعة",
  new_entry: "جديد",
  view_all: "عرض الكل",
  view_profile: "عرض ملف {name}",
  owner_label: "المالك",
  owner_by: "بواسطة {name}",
  loading: "جارٍ التحميل…",
  error_load: "تعذّر تحميل البيانات حالياً. ستتم إعادة المحاولة تلقائياً…",
  error_stale: "انقطع الاتصال: تُعرض آخر القيم المتوفرة.",
  empty_members: "لا يوجد أعضاء معروضون حالياً.",
  empty_brands: "لا توجد علامات تجارية معروضة حالياً.",
  leaderboard_members_label: "ترتيب أفضل الأعضاء",
  leaderboard_brands_label: "ترتيب أفضل العلامات التجارية",
  back_members: "العودة إلى أفضل الأعضاء",
  back_brands: "العودة إلى أفضل العلامات التجارية",
  not_found_member_title: "الملف غير موجود",
  not_found_member_text: "هذا العضو غير موجود أو لم يعد معروضاً في الترتيب.",
  not_found_brand_title: "العلامة التجارية غير موجودة",
  not_found_brand_text: "هذه العلامة التجارية غير موجودة أو لم تعد معروضة في الترتيب.",
  stats_title: "الإحصائيات",
  period_24h: "24 ساعة",
  period_7d: "7 أيام",
  period_30d: "30 يوماً",
  period_all: "منذ البداية",
  total_orders: "الطلبات (المجموع)",
  personal_title: "الأرباح الشخصية",
  network_title: "شبكة المسوّقين",
  network_affiliates: "المسوّقون",
  network_note: "تُحتسب أرباح الشبكة بشكل منفصل عن الأرباح الشخصية ولا تدخل في الترتيب.",
  network_off: "الشبكة غير مُفعّلة لهذا العضو.",
  owned_brands: "العلامات التجارية",
  no_brands: "لا توجد علامات تجارية.",
  history_title: "سجل آخر 30 يوماً",
  history_label: "الأرباح اليومية خلال آخر 30 يوماً",
  legend_personal: "شخصي",
  legend_network: "الشبكة",
  legend_brand: "العلامة",
  bar_title: "{day} · {label}: {amount} ({orders} طلب)",
  recent_title: "آخر نشاط",
  recent_empty: "لا يوجد نشاط حديث.",
  event_PERSONAL_SALE: "بيع شخصي",
  event_NETWORK_SALE: "بيع من الشبكة",
  event_BRAND_SALE: "بيع للعلامة",
  event_qty: "{n} طلب",
  time_now: "الآن",
  time_min: "منذ {n} دقيقة",
  time_h: "منذ {n} ساعة",
  time_d: "منذ {n} يوم",
  photo_alt: "صورة {name}",
  product_alt: "منتج العلامة {name}",
  currency: "درهم",
};

export const DEMO_COMP_TEXT = Object.freeze({ ar: Object.freeze(ar), fr: Object.freeze(fr) });

/** Event types that have a label (event_<TYPE>). */
export const DEMO_EVENT_TYPES = Object.freeze(["PERSONAL_SALE", "NETWORK_SALE", "BRAND_SALE"]);

/** Supported languages; anything else falls back to French. */
export const demoLang = (lang) => (lang === "ar" ? "ar" : "fr");
export const demoDir = (lang) => (demoLang(lang) === "ar" ? "rtl" : "ltr");

/** Translator for one language: t('rank_of', { rank, total }). Missing key → French → key. */
export function demoT(lang) {
  const dict = DEMO_COMP_TEXT[demoLang(lang)];
  return (key, vars) => {
    const raw = dict[key] ?? DEMO_COMP_TEXT.fr[key] ?? key;
    return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : raw;
  };
}

// ── Display helpers (pure) ───────────────────────────────────────────────────

const NUMBER_FORMATS = {
  fr: [new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }), new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
  // Arabic pages keep Western digits (as the rest of the storefront does).
  ar: [new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }), new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
};

/** Centimes → number text (no unit): whole dirhams without decimals, otherwise 2 decimals. */
export function formatAmount(cents, lang) {
  const c = Math.round(Number(cents) || 0);
  const [whole, decimal] = NUMBER_FORMATS[demoLang(lang)];
  return c % 100 === 0 ? whole.format(c / 100) : decimal.format(c / 100);
}

/** Integer count text (orders, affiliates). */
export function formatCount(n, lang) {
  return NUMBER_FORMATS[demoLang(lang)][0].format(Math.round(Number(n) || 0));
}

/** Currency unit: "DH" (fr) / "درهم" (ar). */
export const currencyUnit = (lang) => DEMO_COMP_TEXT[demoLang(lang)].currency;

/** Full money text, e.g. "1 234 DH" / "1,234 درهم" (prefer the <Money> component in JSX: LTR number island). */
export const formatMoney = (cents, lang) => `${formatAmount(cents, lang)} ${currencyUnit(lang)}`;

/** Relative time of `at` versus `now` (both ISO strings / Date / ms): "il y a 5 min". */
export function relativeTime(at, now, lang) {
  const t = demoT(lang);
  const a = new Date(at).getTime();
  const b = new Date(now).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  const s = Math.max(0, Math.floor((b - a) / 1000));
  if (s < 60) return t("time_now");
  if (s < 3600) return t("time_min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time_h", { n: Math.floor(s / 3600) });
  return t("time_d", { n: Math.floor(s / 86400) });
}

/** Short day label of a Casablanca day key 'YYYY-MM-DD' ("9 nov." / "9 نونبر"). */
export function dayLabel(dayKey, lang) {
  const d = new Date(`${dayKey}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return String(dayKey ?? "");
  return d.toLocaleDateString(demoLang(lang) === "ar" ? "ar-MA" : "fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Up to two initials of a name (fallback avatar — never a generic logo). */
export function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const second = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? "" : "";
  return (first + second).toUpperCase();
}

/** Deterministic hue (0..359) from an id, for the initials background. */
export function hueOf(id) {
  let h = 0;
  for (const ch of String(id ?? "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
