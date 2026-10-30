// Shared helpers for the /admin/brand tabs (client side).

export const inputCls = "w-full text-sm border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 focus:outline-none focus:border-gray-400";
export const btnPrimary = "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50";
export const btnGhost = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100 disabled:opacity-50";

/** Server validation codes (src/lib/brandProgram.js) → French messages. */
export const ERROR_TEXT = {
  INVALID_ID: "Identifiant invalide",
  DUPLICATE_ID: "Identifiant en double",
  INVALID_NAME: "Nom requis (2 à 80 caractères)",
  INVALID_PRICE: "Prix invalide (supérieur à 0)",
  INVALID_NUMBER: "Nombre entier invalide",
  INVALID_PERCENT: "Pourcentage entier invalide (0 à 100)",
  INVALID_BOOLEAN: "Valeur invalide",
  TOO_MANY_FEATURES: "Trop d'éléments inclus",
  TOO_MANY_PACKAGES: "Trop de packs",
  TOO_MANY_OPTIONS: "Trop d'options",
  PACKAGE_REMOVED: "Un pack enregistré ne peut pas être supprimé : désactivez-le",
  MAX_BELOW_MIN: "Le maximum doit être supérieur ou égal au minimum",
  DELIVERY_BEFORE_CONFIRMATION: "Le délai de livraison doit être supérieur ou égal au délai de confirmation",
  REQUIRED_WHEN_ENABLED: "Requis quand la simulation est activée",
  VOLUME_REQUIRED: "Le volume maximum doit être d'au moins 1 commande",
  DISTRIBUTION_NOT_100: "La répartition doit totaliser exactement 100 %",
  INVALID_TEXT: "Texte invalide",
  TERMS_TOO_LONG: "Texte trop long",
  INVALID_LIST: "Liste invalide",
  INVALID_PRODUCT_ID: "Identifiant de produit invalide",
  TOO_MANY_PRODUCTS: "Trop de produits dans le catalogue",
  INVALID_AMOUNT: "Montant invalide (0 ou plus, 2 décimales)",
  INVALID_PRODUCT_COUNT: "Le nombre de produits doit être 3 ou 4",
  INVALID_BASE: "Base de calcul invalide",
  PERCENT_SUM_OVER_100: "Les pourcentages appliqués à une même base ne peuvent pas dépasser 100 %",
  REQUIRED_WHEN_ACTIVE: "Requis pour activer le pack",
  NOT_ENOUGH_PRODUCTS: "Le pack doit contenir au moins autant de produits que le nombre à choisir",
  PRODUCT_NOT_IN_CATALOGUE: "Un produit du pack n’est plus dans le catalogue (onglet Catalogue produits)",
};

export const errText = (code) => (code ? ERROR_TEXT[code] || code : null);

export function FieldError({ code }) {
  const msg = errText(code);
  return msg ? <p className="text-[11px] text-red-600 mt-1">{msg}</p> : null;
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-600 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-400 mt-1">{hint}</span>}
      <FieldError code={error} />
    </label>
  );
}

export function Check({ label, checked, onChange, error }) {
  return (
    <div>
      <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
        <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      <FieldError code={error} />
    </div>
  );
}

/** fetch → { ok, status, data, error } (API errors carry a French message). */
export async function api(url, { method = "GET", body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data?.error || "Erreur") };
  } catch {
    return { ok: false, status: 0, data: null, error: "Erreur réseau" };
  }
}

/** Stable lowercase id for a new package / option (never reused once saved). */
export function newId(prefix) {
  const rand = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`.toLowerCase();
}
