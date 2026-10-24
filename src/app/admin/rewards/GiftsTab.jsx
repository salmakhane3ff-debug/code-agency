"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Loader2, Pencil, Archive, RotateCcw, Power, PackagePlus, ImagePlus, X } from "lucide-react";
import ImageSelector from "@/components/block/ImageSelector";
import { STOCK_UI, Badge, Modal, ErrorNote, api, fmtPoints, inputCls, btnPrimary, btnGhost } from "./ui";

const FILTERS = [
  ["all", "Tous"], ["active", "Actifs"], ["inactive", "Inactifs"],
  ["low", "Stock faible"], ["out", "Rupture"], ["archived", "Archivés"],
];

const EMPTY = { name: "", description: "", images: [], pointsCost: "", stock: "0", lowStockThreshold: "", maxPerAffiliate: "", minDeliveredOrders: "", sortOrder: "0", isActive: false };

/** "" → null, numeric strings → numbers (the server validates ranges). */
const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

export default function GiftsTab() {
  const [filter, setFilter]   = useState("all");
  const [gifts, setGifts]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [editing, setEditing] = useState(null);   // gift | "new"
  const [stockFor, setStockFor] = useState(null); // gift
  const [busyId, setBusyId]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api(`/api/admin/rewards/gifts?filter=${filter}`);
    setGifts(r.ok && Array.isArray(r.data) ? r.data : []);
    setError(r.ok ? null : r.error);
    setLoading(false);
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const statusAction = async (gift, action) => {
    if (action === "archive" && !confirm(`Archiver « ${gift.name} » ? Il disparaîtra du catalogue (les demandes existantes sont conservées).`)) return;
    setBusyId(gift.id);
    const r = await api(`/api/admin/rewards/gifts/${gift.id}`, { method: "PATCH", body: { action } });
    setBusyId(null);
    if (!r.ok) setError(r.error); else load();
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex flex-wrap gap-2 items-center">
        {FILTERS.map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${filter === key ? "bg-gray-900 text-white border-gray-900" : "bg-gray-50 text-gray-600 border-gray-200"}`}>
            {label}
          </button>
        ))}
        <button onClick={() => setEditing("new")} className={`${btnPrimary} ml-auto`}><Plus className="w-3.5 h-3.5" /> Nouveau cadeau</button>
      </div>
      <ErrorNote message={error} />

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-gray-400" /></div>
      ) : gifts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 py-14 text-center text-gray-400 text-sm">Aucun cadeau</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {gifts.map((g) => (
            <div key={g.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden flex flex-col">
              <div className="aspect-[4/3] bg-gray-50 flex items-center justify-center">
                {g.images?.[0]
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={g.images[0]} alt={g.name} className="w-full h-full object-cover" />
                  : <ImagePlus className="w-8 h-8 text-gray-300" />}
              </div>
              <div className="p-4 flex-1 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-bold text-gray-900 leading-tight">{g.name}</h3>
                  <span className="text-sm font-black text-violet-700 whitespace-nowrap">{fmtPoints(g.pointsCost)}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  <Badge ui={STOCK_UI[g.stockState]} />
                  <span className="text-xs text-gray-500">Stock : <b>{g.stock}</b></span>
                  {g.archivedAt
                    ? <Badge ui={{ label: "Archivé", cls: "bg-gray-100 text-gray-600 border-gray-200" }} />
                    : <Badge ui={g.isActive ? { label: "Actif", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" } : { label: "Inactif", cls: "bg-gray-50 text-gray-500 border-gray-200" }} />}
                  {g.openRequests > 0 && <span className="text-xs text-gray-500">· {g.openRequests} demande(s) en cours</span>}
                </div>
                {g.description && <p className="text-xs text-gray-500 line-clamp-2">{g.description}</p>}
                <div className="mt-auto pt-2 flex flex-wrap gap-1.5">
                  {!g.archivedAt && <button onClick={() => setEditing(g)} className={btnGhost}><Pencil className="w-3.5 h-3.5" /> Modifier</button>}
                  {!g.archivedAt && <button onClick={() => setStockFor(g)} className={btnGhost}><PackagePlus className="w-3.5 h-3.5" /> Stock</button>}
                  {!g.archivedAt && (
                    <button disabled={busyId === g.id} onClick={() => statusAction(g, g.isActive ? "deactivate" : "activate")} className={btnGhost}>
                      <Power className="w-3.5 h-3.5" /> {g.isActive ? "Désactiver" : "Activer"}
                    </button>
                  )}
                  {g.archivedAt
                    ? <button disabled={busyId === g.id} onClick={() => statusAction(g, "restore")} className={btnGhost}><RotateCcw className="w-3.5 h-3.5" /> Restaurer</button>
                    : <button disabled={busyId === g.id} onClick={() => statusAction(g, "archive")} className={`${btnGhost} text-red-600`}><Archive className="w-3.5 h-3.5" /> Archiver</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <GiftEditor gift={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {stockFor && <StockDialog gift={stockFor} onClose={() => setStockFor(null)} onSaved={() => { setStockFor(null); load(); }} />}
    </div>
  );
}

function GiftEditor({ gift, onClose, onSaved }) {
  const isNew = !gift;
  const [form, setForm] = useState(() => isNew ? EMPTY : {
    name: gift.name, description: gift.description || "", images: gift.images || [],
    pointsCost: String(gift.pointsCost), lowStockThreshold: gift.lowStockThreshold ?? "",
    maxPerAffiliate: gift.maxPerAffiliate ?? "", minDeliveredOrders: gift.minDeliveredOrders ?? "",
    sortOrder: String(gift.sortOrder ?? 0),
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const save = async () => {
    setSaving(true); setError(null);
    const body = {
      name: form.name, description: form.description, images: form.images,
      pointsCost: num(form.pointsCost), lowStockThreshold: num(form.lowStockThreshold),
      maxPerAffiliate: num(form.maxPerAffiliate), minDeliveredOrders: num(form.minDeliveredOrders),
      sortOrder: num(form.sortOrder) ?? 0,
      ...(isNew ? { stock: num(form.stock) ?? 0, isActive: !!form.isActive } : {}),
    };
    const r = isNew
      ? await api("/api/admin/rewards/gifts", { method: "POST", body })
      : await api(`/api/admin/rewards/gifts/${gift.id}`, { method: "PUT", body });
    setSaving(false);
    if (r.ok) onSaved();
    else setError(r.data?.errors ? `${r.error} (${Object.keys(r.data.errors).join(", ")})` : r.error);
  };

  const field = (label, key, props = {}) => (
    <label className="block">
      <span className="text-xs font-semibold text-gray-600">{label}</span>
      <input value={form[key]} onChange={set(key)} className={`${inputCls} mt-1`} {...props} />
    </label>
  );

  return (
    <Modal title={isNew ? "Nouveau cadeau" : `Modifier « ${gift.name} »`} onClose={saving ? () => {} : onClose} wide>
      <div className="space-y-4">
        <ErrorNote message={error} />
        {field("Nom *", "name", { maxLength: 120 })}
        <label className="block">
          <span className="text-xs font-semibold text-gray-600">Description</span>
          <textarea value={form.description} onChange={set("description")} maxLength={2000} className={`${inputCls} mt-1 h-24`} />
        </label>

        <div>
          <span className="text-xs font-semibold text-gray-600">Images ({form.images.length}/10)</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {form.images.map((url, i) => (
              <div key={url} className="relative w-20 h-20 rounded-xl overflow-hidden border border-gray-200 bg-gray-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="w-full h-full object-cover" />
                {i === 0 && <span className="absolute bottom-0 inset-x-0 text-[10px] text-center bg-black/60 text-white">Principale</span>}
                <button type="button" onClick={() => setForm((f) => ({ ...f, images: f.images.filter((u) => u !== url) }))}
                  className="absolute top-1 right-1 bg-white/90 rounded-full p-0.5" aria-label="Retirer"><X className="w-3 h-3" /></button>
              </div>
            ))}
            {form.images.length < 10 && (
              <button type="button" onClick={() => setPickerOpen(true)}
                className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-400 hover:border-gray-400 text-[11px]">
                <ImagePlus className="w-5 h-5" /> Ajouter
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field("Coût en points *", "pointsCost", { type: "number", min: 1, step: 1 })}
          {isNew
            ? field("Stock initial", "stock", { type: "number", min: 0, step: 1 })
            : <p className="text-xs text-gray-500 self-end pb-2">Stock actuel : <b>{gift.stock}</b> — utilisez « Stock » pour l’ajuster.</p>}
          {field("Seuil de stock faible (vide = défaut)", "lowStockThreshold", { type: "number", min: 0, step: 1 })}
          {field("Max par affilié (vide = illimité)", "maxPerAffiliate", { type: "number", min: 1, step: 1 })}
          {field("Commandes livrées minimum (vide = aucune)", "minDeliveredOrders", { type: "number", min: 0, step: 1 })}
          {field("Ordre d’affichage", "sortOrder", { type: "number", step: 1 })}
        </div>
        {isNew && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={!!form.isActive} onChange={set("isActive")} /> Activer immédiatement dans le catalogue
          </label>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={saving} className={btnGhost}>Annuler</button>
          <button onClick={save} disabled={saving} className={btnPrimary}>
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Enregistrer
          </button>
        </div>
      </div>
      <ImageSelector isOpen={pickerOpen} onClose={() => setPickerOpen(false)} selectType="multiple"
        onSelectImages={(urls) => setForm((f) => ({ ...f, images: [...new Set([...f.images, ...(Array.isArray(urls) ? urls : [urls])])].slice(0, 10) }))} />
    </Modal>
  );
}

function StockDialog({ gift, onClose, onSaved }) {
  const [delta, setDelta]   = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);
  const n = Number(delta);
  const valid = Number.isInteger(n) && n !== 0 && reason.trim().length >= 5 && gift.stock + n >= 0;

  const save = async () => {
    setSaving(true); setError(null);
    const r = await api(`/api/admin/rewards/gifts/${gift.id}/stock`, { method: "POST", body: { delta: n, reason } });
    setSaving(false);
    if (r.ok) onSaved(); else setError(r.error);
  };

  return (
    <Modal title={`Ajuster le stock — ${gift.name}`} onClose={saving ? () => {} : onClose}>
      <div className="space-y-3">
        <ErrorNote message={error} />
        <p className="text-sm text-gray-600">Stock actuel : <b>{gift.stock}</b>{delta && Number.isInteger(n) ? <> → <b>{gift.stock + n}</b></> : null}</p>
        <input type="number" step={1} value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="+10 ou -2" className={inputCls} />
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motif (obligatoire, 5 caractères min.) — ex. réception fournisseur" className={`${inputCls} h-20`} />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className={btnGhost}>Annuler</button>
          <button onClick={save} disabled={!valid || saving} className={btnPrimary}>{saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Appliquer</button>
        </div>
      </div>
    </Modal>
  );
}
