/**
 * Texts of the affiliate "Create Your Own Brand" dashboard sections (FR/AR),
 * used only by ./BrandDashboard.jsx. Shared brand texts (statuses, disclaimers,
 * chart labels) stay in lib/brandI18n.js and are read through brandT.
 * Same rules as brandI18n: no figure in a text (numbers are interpolated with
 * {n}), and nothing presents simulated data as real sales or earnings.
 */

export const DASHBOARD_TEXT = {
  fr: {
    hero_title: "Créez votre propre marque",
    hero_subtitle: "Lancez une marque e-commerce en toute simplicité avec notre simulateur de formation.",
    hero_no_stock: "Sans stock",
    hero_sim_delivery: "Livraison simulée",
    hero_training: "Formation incluse",
    hero_safe_sim: "Simulation sécurisée",
    analytics_title: "Analyses & performances",
    pill_hours: "{n} h",
    pill_days: "{n} j",
    orders_title: "Commandes",
    orders_live: "(Live)",
    live_chip: "Live · mises à jour automatiques",
    readonly_chip: "Lecture seule",
    latest_count: "{n} dernières",
    sim_tag: "SIMULATION",
    open_order: "Voir le détail de la commande {ref}",
    order_detail_title: "Détail de la commande",
    detail_ref: "Référence",
    detail_product: "Produit",
    detail_status: "Statut",
    detail_time: "Date",
    close: "Fermer",
    products_title: "Mes produits",
    product_selected: "Sélectionné",
    pack_title: "Mon pack de formation",
    order_status_pending: "En attente",
    order_status_confirmed: "Confirmée",
    order_status_inDelivery: "En cours de livraison",
    order_status_delivered: "Livrée",
    order_status_refused: "Refusée",
    order_status_returned: "Retournée",
    order_status_noResponse: "Sans réponse",
    order_status_cancelled: "Annulation",
    kpi_inDelivery: "En cours de livraison",
    kpi_cancelled: "Annulation",
  },
  ar: {
    hero_title: "أنشئ علامتك التجارية الخاصة",
    hero_subtitle: "أطلق علامة تجارية للتجارة الإلكترونية بكل سهولة مع محاكي التدريب الخاص بنا.",
    hero_no_stock: "بدون مخزون",
    hero_sim_delivery: "توصيل محاكى",
    hero_training: "تدريب مشمول",
    hero_safe_sim: "محاكاة آمنة",
    analytics_title: "التحليلات والأداء",
    pill_hours: "{n} ساعة",
    pill_days: "{n} يوم",
    orders_title: "الطلبات",
    orders_live: "(مباشر)",
    live_chip: "مباشر · تحديث تلقائي",
    readonly_chip: "للاطلاع فقط",
    latest_count: "آخر {n}",
    sim_tag: "محاكاة",
    open_order: "عرض تفاصيل الطلب {ref}",
    order_detail_title: "تفاصيل الطلب",
    detail_ref: "المرجع",
    detail_product: "المنتج",
    detail_status: "الحالة",
    detail_time: "التاريخ",
    close: "إغلاق",
    products_title: "منتجاتي",
    product_selected: "مختار",
    pack_title: "باقة التدريب الخاصة بي",
    order_status_pending: "قيد الانتظار",
    order_status_confirmed: "مؤكد",
    order_status_inDelivery: "قيد التوصيل",
    order_status_delivered: "تم التوصيل",
    order_status_refused: "مرفوض",
    order_status_returned: "مرتجع",
    order_status_noResponse: "بدون رد",
    order_status_cancelled: "ملغاة",
    kpi_inDelivery: "قيد التوصيل",
    kpi_cancelled: "ملغاة",
  },
};

/** Translator for these sections: same {var} interpolation and French fallback as brandT. */
export function dashboardT(lang) {
  const dict = DASHBOARD_TEXT[lang === "ar" ? "ar" : "fr"];
  return (key, vars) => {
    const raw = dict[key] ?? DASHBOARD_TEXT.fr[key] ?? key;
    return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : raw;
  };
}
