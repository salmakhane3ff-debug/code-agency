"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, Plus, X, Package, AlertTriangle, Upload, Loader2, ImageOff } from "lucide-react";
import { BRAND_LIMITS, simulatedSellingPriceIssue } from "@/lib/brandProgram";
import { PERCENT_BASES, PERCENT_KEYS, missingPricingFields, packageBreakdown } from "@/lib/brandPricing";
import { api, inputCls, btnGhost, Field, Check, FieldError, newId, errText } from "./ui";

const L = BRAND_LIMITS;
const MIN_P = L.MIN_SELECTED_PRODUCTS;
const MAX_P = L.MAX_SELECTED_PRODUCTS;
/** Same rule as the server (brandProgram.js IMAGE_URL_RE): absolute http(s) URL or a site path, no spaces / quotes / markup. */
const IMAGE_URL_RE = /^(https?:\/\/|\/)[^\s"'<>]*$/;
const isImageUrl = (u) => typeof u === "string" && u.length <= L.IMAGE_URL_MAX && IMAGE_URL_RE.test(u);

const PERCENT_LABEL = { confirmation: "Taux de confirmation", advertising: "Publicité", companyShare: "Part de la société" };
/** Admin warning for an ACTIVE pack whose simulated selling price is missing / invalid / not positive (FR + AR). */
const SIM_PRICE_WARNING_FR = {
  MISSING: "Pack actif sans prix de vente simulé.",
  INVALID: "Pack actif : prix de vente simulé invalide.",
  NOT_POSITIVE: "Pack actif : le prix de vente simulé doit être supérieur à 0.",
};
const SIM_PRICE_WARNING_AR = {
  MISSING: "باقة نشطة بدون ثمن بيع تجريبي.",
  INVALID: "باقة نشطة: ثمن البيع التجريبي غير صالح.",
  NOT_POSITIVE: "باقة نشطة: يجب أن يكون ثمن البيع التجريبي أكبر من 0.",
};
const BASE_LABEL = {
  [PERCENT_BASES.PACKAGE_PRICE]: "Prix du pack",
  [PERCENT_BASES.SUBTOTAL]: "Sous-total HT (prix + livraison + logistique)",
  [PERCENT_BASES.TOTAL_WITH_VAT]: "Total à payer (TTC)",
  [PERCENT_BASES.SIMULATED_ORDERS]: "Commandes simulées (taux, sans montant)",
};
const FIELD_LABEL = {
  price: "prix", deliveryCost: "frais de livraison", logisticsCost: "frais logistiques", vatPercent: "TVA",
  productCount: `contenu du pack (${MIN_P} ou ${MAX_P} produits)`,
  quantity: "nombre de pièces", simulatedSellingPrice: "prix de vente simulé",
  estimatedDailyEarnings: "gain journalier estimé", estimatedMonthlyEarnings: "gain mensuel estimé",
  ...Object.fromEntries(PERCENT_KEYS.flatMap((k) => [[`percentages.${k}.value`, `${PERCENT_LABEL[k]} (%)`], [`percentages.${k}.base`, `${PERCENT_LABEL[k]} (base)`]])),
};

/**
 * A new package starts INACTIVE and empty: no price, cost, percentage or product is pre-filled.
 * Its contents (productIds + productQuantities) are chosen by the admin; productCount is derived by the server.
 */
export function emptyPackage() {
  return {
    id: newId("pkg"), name: "", category: "", description: "", price: "", features: [], specifications: [], images: [], active: false, sortOrder: 0,
    productIds: [], productQuantities: {}, deliveryCost: "", logisticsCost: "", vatPercent: "", quantity: "", simulatedSellingPrice: "",
    estimatedDailyEarnings: "", estimatedMonthlyEarnings: "",
    percentages: { confirmation: { value: "", base: "" }, advertising: { value: "", base: "" }, companyShare: { value: "", base: "" } },
  };
}

const listOf = (v) => (Array.isArray(v) ? v : []);
const blank = (v) => v === "" || v === null || v === undefined;

/**
 * Number of products of the pack, as the server derives it: a 3–4 product contents list sets it; a longer
 * legacy list keeps its stored value (its first N eligible products are the contents) until it is corrected.
 */
function derivedProductCount(pkg) {
  const n = listOf(pkg.productIds).length;
  if (n >= MIN_P && n <= MAX_P) return n;
  return blank(pkg.productCount) ? null : Number(pkg.productCount);
}

/** Admin form values → numbers (or null) so the preview uses the same rules as the server. */
function asNumbers(pkg) {
  const n = (v) => (blank(v) ? null : Number(v));
  return {
    ...pkg,
    price: n(pkg.price), deliveryCost: n(pkg.deliveryCost), logisticsCost: n(pkg.logisticsCost), vatPercent: n(pkg.vatPercent), productCount: derivedProductCount(pkg),
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

function Thumb({ src, size = "w-9 h-9" }) {
  return (
    <span className={`${size} rounded-lg bg-gray-50 overflow-hidden flex items-center justify-center shrink-0`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" /> : <Package className="w-4 h-4 text-gray-300" />}
    </span>
  );
}

const iconBtn = "p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30";
const move = (list, i, d) => { const n = [...list]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; };

/** Editable list of short texts (services inclus as chips, specifications as lines). */
function TextListEditor({ title, hint, items, onChange, max, itemMax, placeholder, error, chips }) {
  const [draft, setDraft] = useState("");
  const full = items.length >= max;
  const add = () => {
    const v = draft.replace(/\s+/g, " ").trim().slice(0, itemMax);
    if (v && !full && !items.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...items, v]);
    setDraft("");
  };
  return (
    <div>
      <p className="text-xs font-semibold text-gray-600 mb-1">{title} <span className="font-normal text-gray-400">({items.length} / {max})</span></p>
      {hint && <p className="text-[11px] text-gray-400 mb-1.5">{hint}</p>}
      {items.length === 0 && <p className="text-xs text-gray-400 mb-2">Aucun élément.</p>}
      {chips ? (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {items.map((f) => (
            <span key={f} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-violet-50 text-violet-700 text-xs">
              <span dir="auto">{f}</span>
              <button type="button" onClick={() => onChange(items.filter((x) => x !== f))} aria-label="Retirer"><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      ) : items.length > 0 && (
        <ul className="space-y-1.5 mb-2">
          {items.map((s, i) => (
            <li key={s} className="flex items-center gap-1 rounded-xl border border-gray-100 ps-3 pe-1 py-1">
              <span dir="auto" className="flex-1 min-w-0 text-xs text-gray-800 break-words">{s}</span>
              <button type="button" aria-label="Monter" disabled={i === 0} onClick={() => onChange(move(items, i, -1))} className={iconBtn}><ArrowUp className="w-3.5 h-3.5" /></button>
              <button type="button" aria-label="Descendre" disabled={i === items.length - 1} onClick={() => onChange(move(items, i, 1))} className={iconBtn}><ArrowDown className="w-3.5 h-3.5" /></button>
              <button type="button" aria-label="Retirer" onClick={() => onChange(items.filter((x) => x !== s))} className={iconBtn}><X className="w-3.5 h-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input className={inputCls} value={draft} maxLength={itemMax} disabled={full} onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } }} placeholder={full ? "Maximum atteint" : placeholder} />
        <button type="button" onClick={add} disabled={full} className={btnGhost}>Ajouter</button>
      </div>
      <FieldError code={error} />
    </div>
  );
}

/**
 * Package gallery: thumbnails (first = cover), reorder, remove, add by URL or upload through the
 * existing media endpoint POST /api/image (multipart "file" → { _id, name, url }).
 */
function GalleryEditor({ images, onChange, onUploaded, error }) {
  const fileRef = useRef(null);
  const [url, setUrl] = useState("");
  const [localErr, setLocalErr] = useState(null);
  const [uploading, setUploading] = useState(false);
  const full = images.length >= L.MAX_PACK_IMAGES;

  const addUrl = () => {
    const u = url.trim();
    setLocalErr(null);
    if (!u) return;
    if (!isImageUrl(u)) return setLocalErr(errText("INVALID_IMAGE"));
    if (images.includes(u)) return setLocalErr("Cette image est déjà dans la galerie.");
    if (full) return setLocalErr(errText("TOO_MANY_IMAGES"));
    onChange([...images, u]);
    setUrl("");
  };

  const upload = async (fileList) => {
    const files = [...(fileList || [])].slice(0, Math.max(0, L.MAX_PACK_IMAGES - images.length));
    if (!files.length) return;
    setLocalErr(null);
    setUploading(true);
    const urls = [];
    const failed = [];
    for (const file of files) {
      if (!file.type?.startsWith("image/")) { failed.push(`${file.name} : ce n’est pas une image`); continue; }
      try {
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch("/api/image", { method: "POST", body: fd });
        const d = await r.json().catch(() => ({}));
        if (r.ok && isImageUrl(d?.url)) urls.push(d.url);
        else failed.push(`${file.name} : ${d?.error || "échec de l’envoi"}`);
      } catch {
        failed.push(`${file.name} : erreur réseau`);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    // Functional update: other edits made while the upload was running are kept.
    if (urls.length) onUploaded(urls);
    if (failed.length) setLocalErr(`Envoi impossible — ${failed.join(" ; ")}`);
  };

  return (
    <div className="rounded-xl border border-gray-100 p-3 space-y-3">
      <div>
        <p className="text-xs font-bold text-gray-700">Galerie du pack <span className="font-normal text-gray-400">({images.length} / {L.MAX_PACK_IMAGES})</span></p>
        <p className="text-[11px] text-gray-500">La première image est la couverture affichée sur la carte du pack côté affilié. Sans image, l’affilié voit les images des produits du pack.</p>
      </div>
      {images.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
          {images.map((src, i) => (
            <div key={src} className="rounded-xl border border-gray-100 overflow-hidden bg-white">
              <div className="relative aspect-square bg-gray-50 flex items-center justify-center">
                <ImageOff className="w-5 h-5 text-gray-300 absolute" aria-hidden="true" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" loading="lazy" className="relative w-full h-full object-cover" />
                {i === 0 && <span className="absolute top-1 start-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-gray-900 text-white">Couverture</span>}
              </div>
              <div className="flex items-center justify-between px-1 py-0.5">
                <button type="button" aria-label="Déplacer avant" disabled={i === 0} onClick={() => onChange(move(images, i, -1))} className={iconBtn}><ChevronLeft className="w-4 h-4" /></button>
                <button type="button" aria-label="Retirer l’image" onClick={() => onChange(images.filter((x) => x !== src))} className={`${iconBtn} hover:text-red-600`}><X className="w-4 h-4" /></button>
                <button type="button" aria-label="Déplacer après" disabled={i === images.length - 1} onClick={() => onChange(move(images, i, 1))} className={iconBtn}><ChevronRight className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <input className={inputCls} value={url} disabled={full} onChange={(ev) => setUrl(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addUrl(); } }}
          placeholder={full ? "Galerie complète" : "https://… ou /uploads/…"} />
        <div className="flex gap-2 shrink-0">
          <button type="button" onClick={addUrl} disabled={full || !url.trim()} className={btnGhost}>Ajouter l’URL</button>
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(ev) => upload(ev.target.files)} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={full || uploading} className={btnGhost}>
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}{uploading ? "Envoi…" : "Téléverser"}
          </button>
        </div>
      </div>
      {localErr && <p className="text-[11px] text-red-600">{localErr}</p>}
      <FieldError code={error} />
    </div>
  );
}

/** The pack's contents: exactly 3–4 catalogue products, each with its pieces (order = display order). */
function ContentsEditor({ pkg, errors, pool, products, catalogIds, onChange }) {
  const ids = listOf(pkg.productIds);
  const quantities = pkg.productQuantities && typeof pkg.productQuantities === "object" ? pkg.productQuantities : {};
  const n = ids.length;
  const legacy = n > MAX_P;
  const inRange = n >= MIN_P && n <= MAX_P;
  const inCatalogue = new Set(catalogIds);
  const find = (id) => products.find((p) => p.id === id);
  const available = pool.filter((p) => !ids.includes(p.id));
  const notOffered = ids.filter((id) => inCatalogue.has(id) && !find(id)?.eligible).length;
  const sum = ids.reduce((a, id) => a + (Number.isSafeInteger(Number(quantities[id])) && Number(quantities[id]) > 0 ? Number(quantities[id]) : 0), 0);
  const allSet = n > 0 && ids.every((id) => !blank(quantities[id]));

  const setIds = (next) => {
    const kept = Object.fromEntries(Object.entries(quantities).filter(([id]) => next.includes(id)));
    onChange({ productIds: next, productQuantities: kept });
  };
  const setQty = (id, v) => {
    const next = { ...quantities };
    if (v === "") delete next[id]; else next[id] = v;
    onChange({ productQuantities: next });
  };
  const contentsError = errors.productIds || (errors.productCount && !inRange ? errors.productCount : null);
  const chip = inRange
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : pkg.active ? "bg-red-50 text-red-700 border-red-200" : "bg-amber-50 text-amber-800 border-amber-200";

  return (
    <div className="rounded-xl border border-gray-100 p-3 space-y-3" data-pack-contents>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-gray-700">Contenu du pack</p>
          <p className="text-[11px] text-gray-500">Le pack définit exactement ses produits ({MIN_P} ou {MAX_P}) et la quantité de chacun : l’affilié ne choisit aucun produit. L’ordre ci-dessous est l’ordre d’affichage.</p>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border shrink-0 ${chip}`} data-pack-count={n}>{n} / {MIN_P}–{MAX_P} produits</span>
      </div>

      {legacy && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1" data-pack-legacy>
          <p className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />Ancien format : ce pack liste {n} produits{blank(pkg.productCount) ? "" : ` (l’affilié en choisissait ${pkg.productCount})`}.</p>
          <p>Un pack doit désormais contenir exactement ses {MIN_P} ou {MAX_P} produits, chacun avec sa quantité. Retirez les produits en trop ci-dessous et indiquez les quantités, puis enregistrez. Rien n’est supprimé automatiquement.</p>
          {!blank(pkg.productCount) && <p>En attendant, une nouvelle demande reçoit les {pkg.productCount} premiers produits proposables de cette liste.</p>}
          {pkg.active && <p className="font-semibold">Tant que ce pack actif n’est pas corrigé (ou désactivé), l’enregistrement de la configuration sera refusé.</p>}
        </div>
      )}
      {!legacy && !inRange && pkg.active && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{errText("PACK_PRODUCTS_COUNT")} pour être actif.</p>
      )}

      {n === 0 && <p className="text-xs text-gray-400">Aucun produit dans ce pack.</p>}
      <ul className="space-y-2">
        {ids.map((id, i) => {
          const p = find(id);
          const outOfPool = !inCatalogue.has(id);
          const deleted = !outOfPool && products.length > 0 && !p;
          return (
            <li key={id} className="flex flex-wrap sm:flex-nowrap items-center gap-2 rounded-xl border border-gray-100 p-2">
              <span className="text-[11px] font-bold text-gray-400 w-4 text-center shrink-0">{i + 1}</span>
              <Thumb src={p?.image} />
              <div className="min-w-0 flex-1 basis-32">
                <p dir="auto" className="text-xs font-semibold text-gray-800 truncate">{p?.title || id}</p>
                {outOfPool && <p className="text-[10px] font-semibold text-red-600">Hors catalogue — à retirer</p>}
                {deleted && <p className="text-[10px] font-semibold text-red-600">Produit introuvable dans la boutique</p>}
                {!outOfPool && p && !p.eligible && <p className="text-[10px] font-semibold text-amber-700">Non proposé actuellement</p>}
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 shrink-0">
                Pièces
                <input className={`${inputCls} w-20 py-1.5`} type="number" min="1" step="1" inputMode="numeric" aria-label={`Quantité — ${p?.title || id}`}
                  value={quantities[id] ?? ""} onChange={(ev) => setQty(id, ev.target.value)} />
              </label>
              <div className="flex items-center shrink-0 ms-auto">
                <button type="button" aria-label="Monter" disabled={i === 0} onClick={() => setIds(move(ids, i, -1))} className={iconBtn}><ArrowUp className="w-4 h-4" /></button>
                <button type="button" aria-label="Descendre" disabled={i === n - 1} onClick={() => setIds(move(ids, i, 1))} className={iconBtn}><ArrowDown className="w-4 h-4" /></button>
                <button type="button" onClick={() => setIds(ids.filter((x) => x !== id))} className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-gray-700 border border-gray-200 hover:bg-gray-50">Retirer</button>
              </div>
            </li>
          );
        })}
      </ul>
      {n > 0 && (
        <p className="text-[11px] text-gray-500">
          Pièces renseignées par produit : {sum}{allSet ? "" : " (quantité facultative : un produit sans quantité s’affiche sans nombre de pièces)"}
          {allSet && !blank(pkg.quantity) && Number(pkg.quantity) !== sum && ` — différent du nombre total de pièces du pack (${pkg.quantity}).`}
        </p>
      )}
      <FieldError code={contentsError} />
      <FieldError code={errors.productQuantities} />
      {notOffered > 0 && <p className="text-[11px] text-amber-700">{notOffered} produit(s) du contenu non proposable(s) actuellement : le pack n’est pas proposé aux affiliés tant qu’ils ne le sont pas.</p>}

      {pool.length === 0
        ? <p className="text-xs text-gray-500">Ajoutez d’abord des produits dans l’onglet « Catalogue produits ».</p>
        : (
          <Field label="Ajouter un produit du catalogue" hint={n >= MAX_P ? `Maximum ${MAX_P} produits : retirez-en un pour en ajouter un autre.` : undefined}>
            <select className={inputCls} value="" disabled={n >= MAX_P || available.length === 0}
              onChange={(ev) => { if (ev.target.value) setIds([...ids, ev.target.value]); }}>
              <option value="">{available.length === 0 ? "— tous les produits du catalogue sont déjà dans le pack —" : "— choisir un produit —"}</option>
              {available.map((p) => <option key={p.id} value={p.id}>{p.title}{p.eligible ? "" : " (non proposé)"}</option>)}
            </select>
          </Field>
        )}
    </div>
  );
}

/** What the affiliate's pack card shows (cover = first gallery image, else the first product image). */
function AffiliatePreview({ pkg, products }) {
  const ids = listOf(pkg.productIds);
  const contents = ids.slice(0, derivedProductCount(pkg) ?? MAX_P).map((id) => products.find((p) => p.id === id)).filter(Boolean);
  const cover = listOf(pkg.images)[0] || contents.find((p) => p.image)?.image || null;
  const q = pkg.productQuantities || {};
  return (
    <div className="rounded-xl border border-gray-100 p-3 space-y-2" data-affiliate-preview>
      <p className="text-xs font-bold text-gray-700">Aperçu affilié (carte du pack)</p>
      <div className="max-w-xs rounded-2xl border border-gray-200 overflow-hidden bg-white">
        <div className="aspect-video bg-gray-50 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {cover ? <img src={cover} alt="" className="w-full h-full object-contain p-2" /> : <Package className="w-8 h-8 text-gray-300" />}
        </div>
        <div className="p-3 space-y-1">
          {pkg.category && <span dir="auto" className="inline-block px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[10px] font-semibold">{pkg.category}</span>}
          <p dir="auto" className="text-sm font-bold text-gray-900">{pkg.name || "Nom du pack"}</p>
          <p className="text-sm font-semibold text-gray-800">{blank(pkg.price) ? "Prix non défini" : mad(pkg.price)}</p>
          <p className="text-[11px] text-gray-500">{contents.length} produit(s){blank(pkg.quantity) ? "" : ` · ${pkg.quantity} pièces`}</p>
          {contents.length > 0 && (
            <div className="flex gap-1.5 pt-1">
              {contents.map((p) => (
                <span key={p.id} className="relative">
                  <Thumb src={p.image} size="w-8 h-8" />
                  {!blank(q[p.id]) && <span className="absolute -bottom-1 -end-1 px-1 rounded bg-gray-900 text-white text-[9px] font-bold">×{q[p.id]}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="text-[11px] text-gray-400">Indicatif : la carte réelle peut différer légèrement selon la langue de l’affilié.</p>
    </div>
  );
}

function PackageEditor({ pkg, index, errors, saved, onPatch, onRemove, pool, products, catalogIds, categories }) {
  const [open, setOpen] = useState(!saved);
  const e = (field) => errors[`packages.${index}.${field}`];
  const errorCount = Object.keys(errors).filter((k) => k.startsWith(`packages.${index}.`)).length;
  const set = (key, value) => onPatch((p) => ({ ...p, [key]: value }));
  const setPct = (k, patch) => onPatch((p) => ({ ...p, percentages: { ...(p.percentages || {}), [k]: { ...(p.percentages?.[k] || {}), ...patch } } }));
  const productIds = listOf(pkg.productIds);
  const legacy = productIds.length > MAX_P;
  const contentsOff = productIds.length < MIN_P || productIds.length > MAX_P;
  const missing = missingPricingFields(asNumbers(pkg));
  // Active pack whose simulated selling price cannot drive the simulator (display only: validation unchanged).
  const simIssue = pkg.active ? simulatedSellingPriceIssue(pkg.simulatedSellingPrice) : null;
  const images = listOf(pkg.images);
  const breakdown = packageBreakdown(asNumbers(pkg));
  const contentErrors = {
    productIds: e("productIds"), productCount: e("productCount"), productQuantities: e("productQuantities"),
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <div className="flex items-center gap-3 min-w-0">
          <Thumb src={images[0] || productIds.map((id) => products.find((p) => p.id === id)?.image).find(Boolean) || null} size="w-10 h-10" />
          <div className="min-w-0">
            <p dir="auto" className="text-sm font-bold text-gray-900 truncate">{pkg.name || "Nouveau pack"}</p>
            <p className="text-xs text-gray-500">
              {pkg.category ? <><bdi>{pkg.category}</bdi>{" · "}</> : null}
              {pkg.price !== "" && pkg.price != null ? `Prix ${pkg.price} MAD` : "Prix non défini"}
              {breakdown ? ` · total à payer ${mad(breakdown.total)}` : ""} · {productIds.length} produit(s) · <span className="text-gray-400">{pkg.id}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end items-center gap-2 shrink-0">
          {legacy && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">Ancien format</span>}
          {missing.length > 0 && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">Incomplet</span>}
          {simIssue && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200" data-sim-price-chip={simIssue}>Prix simulé {simIssue === "MISSING" ? "manquant" : "invalide"}</span>}
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
              <input className={inputCls} dir="auto" maxLength={L.NAME_MAX} value={pkg.name ?? ""} onChange={(ev) => set("name", ev.target.value)} />
            </Field>
            <Field label="Catégorie" hint="Affichée sur la carte du pack (ex. Cosmétiques, Accessoires). Facultative." error={e("category")}>
              <input className={inputCls} dir="auto" maxLength={L.CATEGORY_MAX} list={`brand-pack-categories-${index}`} value={pkg.category ?? ""} onChange={(ev) => set("category", ev.target.value)} />
              <datalist id={`brand-pack-categories-${index}`}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label="Prix de l’accès (MAD)" error={e("price")}>
              <input className={inputCls} type="number" min="0" step="0.01" value={pkg.price ?? ""} onChange={(ev) => set("price", ev.target.value)} />
            </Field>
            <Field label="Ordre d’affichage" error={e("sortOrder")}>
              <input className={inputCls} type="number" step="1" value={pkg.sortOrder ?? ""} onChange={(ev) => set("sortOrder", ev.target.value)} />
            </Field>
          </div>
          <Field label="Description (expérience de formation)" error={e("description")}>
            <textarea className={inputCls} dir="auto" rows={3} maxLength={L.DESCRIPTION_MAX} value={pkg.description ?? ""} onChange={(ev) => set("description", ev.target.value)} />
          </Field>

          <GalleryEditor
            images={images}
            error={e("images")}
            onChange={(next) => set("images", next)}
            onUploaded={(urls) => onPatch((p) => ({ ...p, images: [...new Set([...listOf(p.images), ...urls])].slice(0, L.MAX_PACK_IMAGES) }))}
          />

          <ContentsEditor pkg={pkg} errors={contentErrors} pool={pool} products={products} catalogIds={catalogIds} onChange={(patch) => onPatch((p) => ({ ...p, ...patch }))} />

          <div className="rounded-xl border border-gray-100 p-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nombre total de pièces du pack (quantité physique)" error={e("quantity")}>
                <input className={inputCls} type="number" min="1" step="1" value={pkg.quantity ?? ""} onChange={(ev) => set("quantity", ev.target.value)} />
              </Field>
              <Field label="Prix de vente simulé (MAD) — commandes d’entraînement uniquement" error={e("simulatedSellingPrice")}>
                <input className={inputCls} type="number" min="0.01" step="0.01" value={pkg.simulatedSellingPrice ?? ""} onChange={(ev) => set("simulatedSellingPrice", ev.target.value)} />
              </Field>
            </div>
            <div className="rounded-xl bg-violet-50/60 border border-violet-100 p-3 space-y-2" data-estimates>
              <p className="text-xs font-bold text-violet-900">Estimations affichées à l’affilié (facultatif)</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Gain journalier estimé (DH)" error={e("estimatedDailyEarnings")}>
                  <input className={inputCls} type="number" min="0.01" step="0.01" placeholder="Vide = non affiché" value={pkg.estimatedDailyEarnings ?? ""} onChange={(ev) => set("estimatedDailyEarnings", ev.target.value)} data-estimate-daily />
                </Field>
                <Field label="Gain mensuel estimé (DH)" error={e("estimatedMonthlyEarnings")}>
                  <input className={inputCls} type="number" min="0.01" step="0.01" placeholder="Vide = non affiché" value={pkg.estimatedMonthlyEarnings ?? ""} onChange={(ev) => set("estimatedMonthlyEarnings", ev.target.value)} data-estimate-monthly />
                </Field>
              </div>
              <p className="text-[11px] text-violet-800">Montants saisis par vous, présentés comme des estimations indicatives, sans engagement, sur l’étape « Détails du pack ». Jamais calculés automatiquement, jamais ajoutés à un solde, une commission, un profit ou aux statistiques. Laissez vide pour masquer l’indicateur.</p>
            </div>
            {simIssue && (
              <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1.5" data-sim-price-warning={simIssue}>
                <p className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />{SIM_PRICE_WARNING_FR[simIssue]}</p>
                <p>Tant que ce prix n’est pas renseigné, le simulateur ne peut pas calculer de chiffre d’affaires ni de profit simulés significatifs pour les nouvelles demandes de ce pack : ils s’affichent « — ». Aucun autre prix (prix du pack, prix d’un produit) n’est utilisé à sa place.</p>
                <p dir="rtl" lang="ar" className="text-start">{SIM_PRICE_WARNING_AR[simIssue]} ما دام هذا الثمن غير محدد، لا يستطيع المحاكي حساب رقم معاملات أو أرباح تجريبية ذات معنى للطلبات الجديدة لهذه الباقة: تظهر «—». لا يُستعمل أي ثمن آخر مكانه (ثمن الباقة أو ثمن منتج).</p>
              </div>
            )}
            <p className="text-[11px] text-gray-500">Figés dans chaque nouvelle demande. Le prix de vente simulé sert uniquement aux chiffres d’entraînement (frais simulés fixes : 65 MAD par commande) ; aucun montant réel n’est crédité.</p>
          </div>

          <TextListEditor
            title="Services inclus"
            hint="Affichés à l’affilié sous « Inclus dans la formation »."
            items={listOf(pkg.features)}
            onChange={(next) => set("features", next)}
            max={L.MAX_FEATURES}
            itemMax={L.FEATURE_MAX}
            placeholder="Ex. module, accès au tableau de bord…"
            error={e("features")}
            chips
          />

          <TextListEditor
            title="Spécifications"
            hint="Une ligne par caractéristique (ex. « Format : 50 ml », « Livraison sous 48 h »)."
            items={listOf(pkg.specifications)}
            onChange={(next) => set("specifications", next)}
            max={L.MAX_SPECIFICATIONS}
            itemMax={L.SPEC_MAX}
            placeholder="Ajouter une spécification…"
            error={e("specifications")}
          />

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

          {missing.length > 0
            ? <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">Pack incomplet — il ne peut pas être activé ni proposé. À compléter : {missing.map((f) => FIELD_LABEL[f] || f).join(", ")}.</p>
            : <Preview pkg={pkg} />}

          <AffiliatePreview pkg={pkg} products={products} />

          <Check label="Pack actif (proposé aux affiliés quand le service est activé et que le pack est complet)" checked={pkg.active} onChange={(x) => set("active", x)} error={e("active")} />
          {pkg.active && contentsOff && (
            <p className="text-[11px] text-red-600">Un pack actif doit contenir exactement {MIN_P} ou {MAX_P} produits : l’enregistrement sera refusé tant que son contenu n’est pas corrigé.</p>
          )}
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
  const categories = [...new Set(cfg.packages.map((p) => String(p.category || "").trim()).filter(Boolean))];
  // Functional updates (by id, else by position): an upload finishing later never overwrites other edits.
  const patch = (i, id, fn) => setCfg((c) => ({ ...c, packages: c.packages.map((p, j) => ((id ? p.id === id : j === i) ? fn(p) : p)) }));
  const remove = (i) => setCfg((c) => ({ ...c, packages: c.packages.filter((_, j) => j !== i) }));
  const add = () => setCfg((c) => ({ ...c, packages: [...c.packages, emptyPackage()] }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">Chaque pack donne accès au simulateur de formation et définit ses {MIN_P} ou {MAX_P} produits (avec leurs quantités). Rien n’est pré-rempli.</p>
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
          onPatch={(fn) => patch(i, p.id, fn)}
          onRemove={() => remove(i)}
          pool={pool}
          products={products}
          catalogIds={cfg.catalogProductIds || []}
          categories={categories}
        />
      ))}
    </div>
  );
}
