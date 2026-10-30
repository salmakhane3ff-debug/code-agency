"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Plus, X, Package } from "lucide-react";
import { BRAND_LIMITS } from "@/lib/brandProgram";
import { PERCENT_BASES, PERCENT_KEYS, missingPricingFields, packageBreakdown } from "@/lib/brandPricing";
import { api, inputCls, btnGhost, Field, Check, FieldError, newId } from "./ui";

const PERCENT_LABEL = { confirmation: "Taux de confirmation", advertising: "Publicité", companyShare: "Part de la société" };
const BASE_LABEL = {
  [PERCENT_BASES.PACKAGE_PRICE]: "Prix du pack",
  [PERCENT_BASES.SUBTOTAL]: "Sous-total HT (prix + livraison + logistique)",
  [PERCENT_BASES.TOTAL_WITH_VAT]: "Total à payer (TTC)",
  [PERCENT_BASES.SIMULATED_ORDERS]: "Commandes simulées (taux, sans montant)",
};
const FIELD_LABEL = {
  price: "prix", deliveryCost: "frais de livraison", logisticsCost: "frais logistiques", vatPercent: "TVA", productCount: "nombre de produits",
  ...Object.fromEntries(PERCENT_KEYS.flatMap((k) => [[`percentages.${k}.value`, `${PERCENT_LABEL[k]} (%)`], [`percentages.${k}.base`, `${PERCENT_LABEL[k]} (base)`]])),
};

/** A new package starts INACTIVE and empty: no price, cost, percentage or product is pre-filled. */
export function emptyPackage() {
  return {
    id: newId("pkg"), name: "", description: "", price: "", features: [], active: false, sortOrder: 0,
    productCount: "", productIds: [], deliveryCost: "", logisticsCost: "", vatPercent: "",
    percentages: { confirmation: { value: "", base: "" }, advertising: { value: "", base: "" }, companyShare: { value: "", base: "" } },
  };
}

/** Admin form values → numbers (or null) so the preview uses the same rules as the server. */
function asNumbers(pkg) {
  const n = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
  return {
    ...pkg,
    price: n(pkg.price), deliveryCost: n(pkg.deliveryCost), logisticsCost: n(pkg.logisticsCost), vatPercent: n(pkg.vatPercent), productCount: n(pkg.productCount),
    percentages: Object.fromEntries(PERCENT_KEYS.map((k) => [k, { value: n(pkg.percentages?.[k]?.value), base: pkg.percentages?.[k]?.base || null }])),
  };
}

const mad = (x) => `${Number(x).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD`;

function Preview({ pkg }) {
  const b = packageBreakdown(asNumbers(pkg));
  if (!b) return null;
  const row = (l, v, strong) => <p className={`flex justify-between gap-3 ${strong ? "font-bold text-gray-900" : "text-gray-600"}`}><span>{l}</span><span>{v}</span></p>;
  return (
    <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 text-xs space-y-1">
      <p className="font-bold text-gray-700 mb-1">Aperçu du calcul (identique à celui affiché à l’affilié)</p>
      {row("Prix du pack", mad(b.price))}
      {row("+ Frais de livraison", mad(b.deliveryCost))}
      {row("+ Frais logistiques", mad(b.logisticsCost))}
      {row("= Sous-total HT", mad(b.subtotal))}
      {row(`+ TVA ${b.vat.percent} % × sous-total`, mad(b.vat.amount))}
      {row("= Total à payer", mad(b.total), true)}
      <p className="pt-1 font-semibold text-gray-500">Indicatif — non ajouté au total :</p>
      {b.informational.map((x) => row(`${PERCENT_LABEL[x.key]} ${x.percent} % × ${BASE_LABEL[x.base]}${x.baseAmount !== null ? ` (${mad(x.baseAmount)})` : ""}`,
        x.amount !== null ? mad(x.amount) : `${x.percent} %`))}
    </div>
  );
}

function PackageEditor({ pkg, index, errors, saved, onChange, onRemove, pool }) {
  const [open, setOpen] = useState(!saved);
  const [feature, setFeature] = useState("");
  const e = (field) => errors[`packages.${index}.${field}`];
  const errorCount = Object.keys(errors).filter((k) => k.startsWith(`packages.${index}.`)).length;
  const set = (key, value) => onChange({ ...pkg, [key]: value });
  const setPct = (k, patch) => set("percentages", { ...(pkg.percentages || {}), [k]: { ...(pkg.percentages?.[k] || {}), ...patch } });
  const productIds = Array.isArray(pkg.productIds) ? pkg.productIds : [];
  const toggleProduct = (id) => set("productIds", productIds.includes(id) ? productIds.filter((x) => x !== id) : [...productIds, id]);
  const missing = missingPricingFields(asNumbers(pkg));
  const eligibleListed = productIds.filter((id) => pool.find((p) => p.id === id)?.eligible).length;
  const features = Array.isArray(pkg.features) ? pkg.features : [];
  const addFeature = () => {
    const f = feature.replace(/\s+/g, " ").trim();
    if (f && !features.some((x) => x.toLowerCase() === f.toLowerCase())) set("features", [...features, f]);
    setFeature("");
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{pkg.name || "Nouveau pack"}</p>
          <p className="text-xs text-gray-500">
            {pkg.price !== "" && pkg.price != null ? `Prix ${pkg.price} MAD` : "Prix non défini"}
            {packageBreakdown(asNumbers(pkg)) ? ` · total à payer ${mad(packageBreakdown(asNumbers(pkg)).total)}` : ""} · <span className="text-gray-400">{pkg.id}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {missing.length > 0 && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">Incomplet</span>}
          {errorCount > 0 && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200">{errorCount} erreur(s)</span>}
          <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${pkg.active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
            {pkg.active ? "Actif" : "Inactif"}
          </span>
          <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-4 space-y-4">
          <FieldError code={e("id")} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nom du pack" error={e("name")}>
              <input className={inputCls} value={pkg.name ?? ""} onChange={(ev) => set("name", ev.target.value)} />
            </Field>
            <Field label="Prix de l’accès (MAD)" error={e("price")}>
              <input className={inputCls} type="number" min="0" step="0.01" value={pkg.price ?? ""} onChange={(ev) => set("price", ev.target.value)} />
            </Field>
            <Field label="Ordre d’affichage" error={e("sortOrder")}>
              <input className={inputCls} type="number" step="1" value={pkg.sortOrder ?? ""} onChange={(ev) => set("sortOrder", ev.target.value)} />
            </Field>
          </div>
          <Field label="Description (expérience de formation)">
            <textarea className={inputCls} rows={3} value={pkg.description ?? ""} onChange={(ev) => set("description", ev.target.value)} />
          </Field>

          <div>
            <p className="text-xs font-semibold text-gray-600 mb-1">Inclus dans la formation</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {features.map((f) => (
                <span key={f} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-violet-50 text-violet-700 text-xs">
                  {f}
                  <button type="button" onClick={() => set("features", features.filter((x) => x !== f))} aria-label="Retirer"><X className="w-3 h-3" /></button>
                </span>
              ))}
              {features.length === 0 && <span className="text-xs text-gray-400">Aucun élément.</span>}
            </div>
            <div className="flex gap-2">
              <input className={inputCls} value={feature} onChange={(ev) => setFeature(ev.target.value)}
                onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addFeature(); } }} placeholder="Ex. module, accès au tableau de bord…" />
              <button type="button" onClick={addFeature} className={btnGhost}>Ajouter</button>
            </div>
            <FieldError code={e("features")} />
          </div>

          <div className="rounded-xl border border-gray-100 p-3 space-y-3">
            <p className="text-xs font-bold text-gray-700">Coûts et TVA (montant payé = prix + livraison + logistique + TVA sur ce sous-total)</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Frais de livraison (MAD)" error={e("deliveryCost")}>
                <input className={inputCls} type="number" min="0" step="0.01" value={pkg.deliveryCost ?? ""} onChange={(ev) => set("deliveryCost", ev.target.value)} />
              </Field>
              <Field label="Frais logistiques (MAD)" error={e("logisticsCost")}>
                <input className={inputCls} type="number" min="0" step="0.01" value={pkg.logisticsCost ?? ""} onChange={(ev) => set("logisticsCost", ev.target.value)} />
              </Field>
              <Field label="TVA (%) — appliquée au sous-total" error={e("vatPercent")}>
                <input className={inputCls} type="number" min="0" max="100" step="0.01" value={pkg.vatPercent ?? ""} onChange={(ev) => set("vatPercent", ev.target.value)} />
              </Field>
            </div>
          </div>

          <div className="rounded-xl border border-gray-100 p-3 space-y-3">
            <p className="text-xs font-bold text-gray-700">Pourcentages indicatifs (affichés à l’affilié, jamais ajoutés au total) — choisissez la base de chacun</p>
            <FieldError code={e("percentages")} />
            {PERCENT_KEYS.map((k) => (
              <div key={k} className="grid gap-3 sm:grid-cols-2">
                <Field label={`${PERCENT_LABEL[k]} (%)`} error={e(`percentages.${k}.value`)}>
                  <input className={inputCls} type="number" min="0" max="100" step="0.01" value={pkg.percentages?.[k]?.value ?? ""} onChange={(ev) => setPct(k, { value: ev.target.value })} />
                </Field>
                <Field label={`Base de calcul — ${PERCENT_LABEL[k]}`} error={e(`percentages.${k}.base`)}>
                  <select className={inputCls} value={pkg.percentages?.[k]?.base ?? ""} onChange={(ev) => setPct(k, { base: ev.target.value })}>
                    <option value="">— à choisir —</option>
                    {Object.values(PERCENT_BASES).map((b) => <option key={b} value={b}>{BASE_LABEL[b]}</option>)}
                  </select>
                </Field>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-gray-100 p-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nombre de produits que l’affilié choisit" error={e("productCount")}>
                <select className={inputCls} value={pkg.productCount ?? ""} onChange={(ev) => set("productCount", ev.target.value)}>
                  <option value="">— à choisir —</option>
                  {[BRAND_LIMITS.MIN_SELECTED_PRODUCTS, BRAND_LIMITS.MAX_SELECTED_PRODUCTS].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
              <p className="text-xs text-gray-500 self-end">{productIds.length} produit(s) dans ce pack, dont {eligibleListed} proposable(s) maintenant.</p>
            </div>
            <FieldError code={e("productIds")} />
            {pool.length === 0 && <p className="text-xs text-gray-500">Ajoutez d’abord des produits dans l’onglet « Catalogue produits ».</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              {pool.map((p) => (
                <label key={p.id} className={`flex items-center gap-2 rounded-xl border p-2 cursor-pointer ${productIds.includes(p.id) ? "border-violet-400 bg-violet-50" : "border-gray-100"}`}>
                  <input type="checkbox" checked={productIds.includes(p.id)} onChange={() => toggleProduct(p.id)} />
                  <span className="w-9 h-9 rounded-lg bg-gray-50 overflow-hidden flex items-center justify-center shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.image ? <img src={p.image} alt="" className="w-full h-full object-cover" /> : <Package className="w-4 h-4 text-gray-300" />}
                  </span>
                  <span dir="auto" className="text-xs font-semibold text-gray-800 truncate">{p.title}</span>
                  {!p.eligible && <span className="ms-auto text-[10px] font-semibold text-amber-700 shrink-0">non proposé</span>}
                </label>
              ))}
            </div>
          </div>

          {missing.length > 0
            ? <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">Pack incomplet — il ne peut pas être activé ni proposé. À compléter : {missing.map((f) => FIELD_LABEL[f] || f).join(", ")}.</p>
            : <Preview pkg={pkg} />}

          <Check label="Pack actif (proposé aux affiliés quand le service est activé et que le pack est complet)" checked={pkg.active} onChange={(x) => set("active", x)} />
          {!saved && (
            <div className="flex justify-end">
              <button type="button" onClick={onRemove} className={btnGhost}>Retirer ce pack (non enregistré)</button>
            </div>
          )}
          {saved && <p className="text-[11px] text-gray-400">Pack enregistré : il ne peut plus être supprimé, seulement désactivé (les demandes gardent une copie du pack acheté).</p>}
        </div>
      )}
    </div>
  );
}

export default function PackagesTab({ cfg, setCfg, errors, savedIds }) {
  // Pool = the catalogue products (Catalogue produits tab), with live eligibility.
  const [products, setProducts] = useState([]);
  useEffect(() => { api("/api/admin/brand/products").then((r) => { if (r.ok) setProducts(r.data); }); }, []);
  const pool = (cfg.catalogProductIds || []).map((id) => products.find((p) => p.id === id)).filter(Boolean);
  const update = (i, next) => setCfg((c) => ({ ...c, packages: c.packages.map((p, j) => (j === i ? next : p)) }));
  const remove = (i) => setCfg((c) => ({ ...c, packages: c.packages.filter((_, j) => j !== i) }));
  const add = () => setCfg((c) => ({ ...c, packages: [...c.packages, emptyPackage()] }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">Chaque pack donne accès au simulateur de formation. Rien n’est pré-rempli.</p>
        <button type="button" onClick={add} className={btnGhost}><Plus className="w-3.5 h-3.5" />Nouveau pack</button>
      </div>
      <FieldError code={errors.packages} />
      {cfg.packages.length === 0 && <p className="text-sm text-gray-500 bg-white rounded-2xl border border-gray-100 p-6 text-center">Aucun pack configuré.</p>}
      {cfg.packages.map((p, i) => (
        <PackageEditor
          key={p.id || i}
          pkg={p}
          index={i}
          errors={errors}
          saved={savedIds.has(p.id)}
          onChange={(next) => update(i, next)}
          onRemove={() => remove(i)}
          pool={pool}
        />
      ))}
    </div>
  );
}
