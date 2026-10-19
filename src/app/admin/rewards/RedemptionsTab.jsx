"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Search, Truck, StickyNote } from "lucide-react";
import { ADMIN_TRANSITIONS } from "@/lib/rewards";
import { REDEMPTION_STATUS_UI, Badge, Modal, ErrorNote, api, fmtDate, fmtPoints, inputCls, btnPrimary, btnGhost } from "./ui";

const FILTERS = ["OPEN", "PENDING_REVIEW", "APPROVED", "PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED", "REJECTED", "CANCELLED", "RETURNED", "ALL"];
const filterLabel = (s) => (s === "OPEN" ? "En cours" : s === "ALL" ? "Toutes" : REDEMPTION_STATUS_UI[s].label);

// What each target status needs from the admin.
const NEEDS = {
  REJECTED:  { reason: true, hint: "Le motif est visible par l'affilié. Les points sont remboursés et le stock remis." },
  CANCELLED: { reason: true, hint: "Les points sont remboursés et le stock remis." },
  SHIPPED:   { carrier: true, hint: "Transporteur obligatoire ; numéro de suivi recommandé." },
  RETURNED:  { returned: true, hint: "Choisissez explicitement le remboursement des points et la remise en stock." },
};

export default function RedemptionsTab() {
  const [status, setStatus] = useState("OPEN");
  const [q, setQ]           = useState("");
  const [query, setQuery]   = useState("");
  const [rows, setRows]     = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async (more = null) => {
    setLoading(true);
    const params = new URLSearchParams({ status, q: query, ...(more ? { cursor: more } : {}) });
    const r = await api(`/api/admin/rewards/redemptions?${params}`);
    if (r.ok) {
      setRows((prev) => (more ? [...prev, ...r.data.items] : r.data.items));
      setCursor(r.data.nextCursor);
      setError(null);
    } else setError(r.error);
    setLoading(false);
  }, [status, query]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${status === s ? "bg-gray-900 text-white border-gray-900" : "bg-gray-50 text-gray-600 border-gray-200"}`}>
              {filterLabel(s)}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Référence, destinataire, téléphone, affilié…" className={`${inputCls} pr-9`} />
        </form>
      </div>
      <ErrorNote message={error} />

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-gray-400" /></div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 py-14 text-center text-gray-400 text-sm">Aucune demande</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <button key={r.id} onClick={() => setOpenId(r.id)}
              className="w-full text-left bg-white rounded-2xl border border-gray-100 p-4 hover:border-gray-300 transition-colors">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs font-bold text-gray-900">{r.reference}</span>
                  <Badge ui={REDEMPTION_STATUS_UI[r.status]} />
                </div>
                <span className="text-sm font-bold text-violet-700">{fmtPoints(r.pointsCost)}</span>
              </div>
              <p className="text-sm text-gray-800 mt-1">{r.giftSnapshot?.name || "—"}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                @{r.affiliate?.username || "?"} · {r.fullName} · {r.city} · {fmtDate(r.createdAt)}
                {r.trackingNumber && <> · <Truck className="inline w-3 h-3" /> {r.trackingNumber}</>}
              </p>
            </button>
          ))}
          {cursor && <button onClick={() => load(cursor)} disabled={loading} className={`${btnGhost} w-full`}>{loading ? "…" : "Charger plus"}</button>}
        </div>
      )}

      {openId && <RedemptionDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => load()} />}
    </div>
  );
}

function RedemptionDetail({ id, onClose, onChanged }) {
  const [red, setRed]         = useState(null);
  const [error, setError]     = useState(null);
  const [target, setTarget]   = useState(null);  // status being applied
  const [form, setForm]       = useState({});
  const [busy, setBusy]       = useState(false);
  const [carriers, setCarriers] = useState([]);
  const [notes, setNotes]     = useState("");

  const load = useCallback(async () => {
    const r = await api(`/api/admin/rewards/redemptions/${id}`);
    if (r.ok) { setRed(r.data); setNotes(r.data.internalNotes || ""); } else setError(r.error);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api("/api/admin/shipping-companies").then((r) => setCarriers(r.ok && Array.isArray(r.data) ? r.data.filter((c) => c.isActive) : []));
  }, []);

  const patch = async (body) => {
    setBusy(true); setError(null);
    const r = await api(`/api/admin/rewards/redemptions/${id}`, { method: "PATCH", body });
    setBusy(false);
    if (!r.ok) { setError(r.error); return false; }
    setRed(r.data); setNotes(r.data.internalNotes || ""); onChanged();
    return true;
  };

  const startTransition = (to) => {
    setTarget(to);
    setForm({ reason: "", note: "", carrierId: red?.carrierId || "", carrierName: red?.carrierName || "", trackingNumber: red?.trackingNumber || "", trackingUrl: red?.trackingUrl || "", refundPoints: null, restock: null });
  };
  const applyTransition = async () => {
    const need = NEEDS[target] || {};
    const body = { toStatus: target, note: form.note || undefined };
    if (need.reason) body.reason = form.reason;
    if (need.carrier || target === "IN_TRANSIT") {
      if (form.carrierId) body.carrierId = form.carrierId; else if (form.carrierName) body.carrierName = form.carrierName;
      if (form.trackingNumber) body.trackingNumber = form.trackingNumber;
      if (form.trackingUrl) body.trackingUrl = form.trackingUrl;
    }
    if (need.returned) { body.refundPoints = form.refundPoints; body.restock = form.restock; }
    if (await patch(body)) setTarget(null);
  };

  if (!red) {
    return <Modal title="Demande" onClose={onClose}>{error ? <ErrorNote message={error} /> : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>}</Modal>;
  }
  const next = ADMIN_TRANSITIONS[red.status] || [];
  const need = NEEDS[target] || {};
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const canApply = target && (!need.reason || form.reason.trim().length >= 5)
    && (!need.carrier || form.carrierId || form.carrierName.trim())
    && (!need.returned || (typeof form.refundPoints === "boolean" && typeof form.restock === "boolean"));

  return (
    <Modal title={`Demande ${red.reference}`} onClose={busy ? () => {} : onClose} wide>
      <div className="space-y-5">
        <ErrorNote message={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge ui={REDEMPTION_STATUS_UI[red.status]} />
          <span className="text-sm font-bold text-violet-700">{fmtPoints(red.pointsCost)}</span>
          <span className="text-xs text-gray-500">créée le {fmtDate(red.createdAt)}</span>
          {red.pointsRefundedAt && <span className="text-xs text-emerald-700">· points remboursés</span>}
          {red.restockedAt && <span className="text-xs text-emerald-700">· remis en stock</span>}
        </div>

        <div className="grid sm:grid-cols-2 gap-4 text-sm">
          <div className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-500 mb-1">Cadeau</p>
            <p className="font-semibold text-gray-900">{red.giftSnapshot?.name}</p>
            <p className="text-xs text-gray-500">Affilié : {red.affiliate?.name || "—"} (@{red.affiliate?.username})</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-500 mb-1">Livraison</p>
            <p className="font-semibold text-gray-900">{red.fullName} · {red.phone}</p>
            <p className="text-xs text-gray-600">{red.address}, {red.city}</p>
            {red.deliveryNotes && <p className="text-xs text-gray-500 mt-1">Note : {red.deliveryNotes}</p>}
          </div>
        </div>

        {(red.carrierName || red.trackingNumber) && (
          <div className="text-sm text-gray-700 flex flex-wrap gap-x-4">
            <span><Truck className="inline w-4 h-4" /> {red.carrierName || "—"}</span>
            {red.trackingNumber && <span>Suivi : <b>{red.trackingNumber}</b></span>}
            {red.trackingUrl && <a href={red.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">Lien de suivi</a>}
          </div>
        )}
        {red.rejectionReason && <p className="text-sm text-red-600">Motif du refus : {red.rejectionReason}</p>}
        {red.cancelReason && <p className="text-sm text-gray-600">Motif d’annulation : {red.cancelReason}</p>}

        {/* Actions: only transitions the server allows from this status. */}
        {next.length > 0 && !target && (
          <div className="flex flex-wrap gap-2">
            {next.map((to) => (
              <button key={to} onClick={() => startTransition(to)}
                className={["REJECTED", "CANCELLED"].includes(to) ? `${btnGhost} text-red-600` : btnPrimary}>
                → {REDEMPTION_STATUS_UI[to].label}
              </button>
            ))}
          </div>
        )}
        {target && (
          <div className="border border-gray-200 rounded-2xl p-4 space-y-3">
            <p className="text-sm font-bold text-gray-900">Passer à « {REDEMPTION_STATUS_UI[target].label} »</p>
            {need.hint && <p className="text-xs text-gray-500">{need.hint}</p>}
            {need.reason && <textarea value={form.reason} onChange={setF("reason")} placeholder="Motif (obligatoire, 5 caractères min.)" className={`${inputCls} h-20`} />}
            {(need.carrier || target === "IN_TRANSIT") && (
              <div className="grid sm:grid-cols-2 gap-2">
                <select value={form.carrierId} onChange={setF("carrierId")} className={inputCls}>
                  <option value="">— Autre transporteur —</option>
                  {carriers.map((c) => <option key={c.id || c._id} value={c.id || c._id}>{c.name}</option>)}
                </select>
                {!form.carrierId && <input value={form.carrierName} onChange={setF("carrierName")} placeholder="Nom du transporteur" className={inputCls} />}
                <input value={form.trackingNumber} onChange={setF("trackingNumber")} placeholder="Numéro de suivi" className={inputCls} />
                <input value={form.trackingUrl} onChange={setF("trackingUrl")} placeholder="Lien de suivi (https://…)" className={inputCls} />
              </div>
            )}
            {need.returned && (
              <div className="space-y-2 text-sm">
                {[["refundPoints", "Rembourser les points à l'affilié ?"], ["restock", "Remettre l'article en stock ?"]].map(([k, label]) => (
                  <div key={k} className="flex items-center gap-3">
                    <span className="flex-1 text-gray-700">{label}</span>
                    {[true, false].map((v) => (
                      <label key={String(v)} className="flex items-center gap-1">
                        <input type="radio" name={k} checked={form[k] === v} onChange={() => setForm((f) => ({ ...f, [k]: v }))} /> {v ? "Oui" : "Non"}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <input value={form.note} onChange={setF("note")} placeholder="Note d'historique (optionnelle)" className={inputCls} />
            <div className="flex justify-end gap-2">
              <button onClick={() => setTarget(null)} disabled={busy} className={btnGhost}>Annuler</button>
              <button onClick={applyTransition} disabled={!canApply || busy} className={btnPrimary}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Confirmer</button>
            </div>
          </div>
        )}

        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1 flex items-center gap-1"><StickyNote className="w-3.5 h-3.5" /> Notes internes (jamais visibles par l’affilié)</p>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className={`${inputCls} h-20`} />
          <div className="flex justify-end mt-2">
            <button disabled={busy || notes === (red.internalNotes || "")} onClick={() => patch({ internalNotes: notes })} className={btnGhost}>Enregistrer les notes</button>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-500 mb-2">Historique</p>
          <ol className="space-y-2 border-l-2 border-gray-100 pl-4">
            {red.history.map((h) => (
              <li key={h.id} className="text-xs text-gray-600">
                <span className="font-semibold text-gray-900">{h.fromStatus ? `${REDEMPTION_STATUS_UI[h.fromStatus]?.label} → ` : ""}{REDEMPTION_STATUS_UI[h.toStatus]?.label}</span>
                {" · "}{fmtDate(h.createdAt)} · {h.actorType === "AFFILIATE" ? "affilié" : h.actorType === "ADMIN" ? "admin" : "système"}
                {h.note && <span className="block text-gray-500">« {h.note} »</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Modal>
  );
}
