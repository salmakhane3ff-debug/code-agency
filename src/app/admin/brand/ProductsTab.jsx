"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Package, ArrowUp, ArrowDown } from "lucide-react";
import { BRAND_LIMITS } from "@/lib/brandProgram";
import { api, inputCls, FieldError } from "./ui";

/**
 * Catalogue offered to affiliates: the admin picks existing store products.
 * Only their ids are saved (with the rest of the config); names, images and
 * availability are read live. A product is offered only while it is published,
 * active and not locked — others stay in the list, flagged, but are not shown
 * to affiliates. Store products are never modified from here.
 */
export default function ProductsTab({ cfg, setCfg, errors }) {
  const [products, setProducts] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api("/api/admin/brand/products").then((r) => (r.ok ? setProducts(r.data) : setLoadError(r.error)));
  }, []);

  const ids = cfg.catalogProductIds || [];
  const setIds = (next) => setCfg((c) => ({ ...c, catalogProductIds: next }));
  const toggle = (id) => setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const move = (i, d) => { const n = [...ids]; [n[i], n[i + d]] = [n[i + d], n[i]]; setIds(n); };

  const byId = useMemo(() => new Map((products || []).map((p) => [p.id, p])), [products]);
  const offered = ids.filter((id) => byId.get(id)?.eligible).length;
  const needle = q.trim().toLowerCase();
  const others = (products || []).filter((p) => !ids.includes(p.id) && (!needle || p.title.toLowerCase().includes(needle)));

  const flag = (p) => {
    if (!p) return <span className="text-[11px] font-semibold text-red-600">Produit supprimé — non proposé</span>;
    if (p.eligible) return <span className="text-[11px] font-semibold text-emerald-700">Proposé</span>;
    const why = [p.status !== "Active" && `statut « ${p.status} »`, !p.isActive && "désactivé", p.isLocked && "verrouillé"].filter(Boolean).join(", ");
    return <span className="text-[11px] font-semibold text-amber-700">Non proposé ({why})</span>;
  };

  if (!products) {
    return <div className="py-10 flex justify-center">{loadError ? <p className="text-sm text-red-600">{loadError}</p> : <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Choisissez les produits de la boutique que les affiliés peuvent sélectionner pour leur marque fictive
        (chaque affilié en choisit de {BRAND_LIMITS.MIN_SELECTED_PRODUCTS} à {BRAND_LIMITS.MAX_SELECTED_PRODUCTS}). Seuls les produits publiés, actifs et non verrouillés sont proposés.
        Les produits eux-mêmes ne sont jamais modifiés.
      </p>
      <FieldError code={errors.catalogProductIds} />
      <p className={`text-xs font-semibold rounded-xl px-3 py-2 border ${offered >= BRAND_LIMITS.MIN_SELECTED_PRODUCTS ? "text-emerald-700 bg-emerald-50 border-emerald-100" : "text-amber-800 bg-amber-50 border-amber-100"}`}>
        {offered} produit(s) proposé(s) aux affiliés
        {offered < BRAND_LIMITS.MIN_SELECTED_PRODUCTS && ` — il en faut au moins ${BRAND_LIMITS.MIN_SELECTED_PRODUCTS} pour qu’une demande soit possible.`}
      </p>

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2">
        <p className="text-sm font-bold text-gray-900">Dans le catalogue ({ids.length})</p>
        {ids.length === 0 && <p className="text-sm text-gray-500 py-4 text-center">Aucun produit dans le catalogue.</p>}
        {ids.map((id, i) => {
          const p = byId.get(id);
          return (
            <div key={id} className="flex items-center gap-3 rounded-xl border border-gray-100 p-2">
              <Thumb src={p?.image} />
              <div className="min-w-0 flex-1">
                <p dir="auto" className="text-sm font-semibold text-gray-800 truncate">{p?.title || id}</p>
                {flag(p)}
              </div>
              <button type="button" aria-label="Monter" disabled={i === 0} onClick={() => move(i, -1)} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
              <button type="button" aria-label="Descendre" disabled={i === ids.length - 1} onClick={() => move(i, 1)} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
              <button type="button" onClick={() => toggle(id)} className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-gray-700 border border-gray-200 hover:bg-gray-50">Retirer</button>
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-gray-900">Produits de la boutique</p>
          <input className={`${inputCls} max-w-xs`} placeholder="Rechercher un produit" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {others.length === 0 && <p className="text-sm text-gray-500 py-4 text-center">Aucun autre produit.</p>}
        {others.map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-xl border border-gray-100 p-2">
            <Thumb src={p.image} />
            <div className="min-w-0 flex-1">
              <p dir="auto" className="text-sm font-semibold text-gray-800 truncate">{p.title}</p>
              {!p.eligible && flag(p)}
            </div>
            <button type="button" onClick={() => toggle(p.id)} className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gray-900 text-white hover:bg-gray-800">Ajouter</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Thumb({ src }) {
  return (
    <div className="w-12 h-12 rounded-lg bg-gray-50 overflow-hidden flex items-center justify-center shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" /> : <Package className="w-5 h-5 text-gray-300" />}
    </div>
  );
}
