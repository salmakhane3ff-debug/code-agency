// Shared helpers for the /admin/rewards tabs (client side).

export const REDEMPTION_STATUS_UI = {
  PENDING_REVIEW: { label: "En attente",    cls: "bg-amber-50 text-amber-700 border-amber-200" },
  APPROVED:       { label: "Approuvée",     cls: "bg-blue-50 text-blue-700 border-blue-200" },
  PREPARING:      { label: "En préparation", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  SHIPPED:        { label: "Expédiée",      cls: "bg-purple-50 text-purple-700 border-purple-200" },
  IN_TRANSIT:     { label: "En transit",    cls: "bg-violet-50 text-violet-700 border-violet-200" },
  DELIVERED:      { label: "Livrée",        cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  REJECTED:       { label: "Refusée",       cls: "bg-red-50 text-red-700 border-red-200" },
  CANCELLED:      { label: "Annulée",       cls: "bg-gray-100 text-gray-600 border-gray-200" },
  RETURNED:       { label: "Retournée",     cls: "bg-orange-50 text-orange-700 border-orange-200" },
};

export const STOCK_UI = {
  OK:  { label: "En stock",     cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  LOW: { label: "Stock faible", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  OUT: { label: "Rupture",      cls: "bg-red-50 text-red-700 border-red-200" },
};

export const LEDGER_TYPE_LABEL = {
  SIGNUP_BONUS:      "Bonus d'inscription",
  ORDER_DELIVERED:   "Commande livrée",
  ORDER_REVERSAL:    "Annulation de commande",
  REDEMPTION_DEBIT:  "Demande de cadeau",
  REDEMPTION_REFUND: "Remboursement de demande",
  ADMIN_ADJUSTMENT:  "Ajustement admin",
};

export function Badge({ ui }) {
  const s = ui || { label: "—", cls: "bg-gray-50 text-gray-600 border-gray-200" };
  return <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border ${s.cls}`}>{s.label}</span>;
}

export function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export const fmtPoints = (n) => `${Number(n || 0).toLocaleString("fr-FR")} pts`;

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

/** Idempotency key for one submit (a retried click reuses it). */
export function newRequestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className={`bg-white w-full ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"} rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto`}>
        <div className="sticky top-0 bg-white flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none" aria-label="Fermer">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function ErrorNote({ message }) {
  if (!message) return null;
  return <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{message}</p>;
}

export const inputCls = "w-full text-sm border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 focus:outline-none focus:border-gray-400";
export const btnPrimary = "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50";
export const btnGhost = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100 disabled:opacity-50";
