"use client";
import React, { useEffect, useState, useCallback } from "react";
import {
  GripVertical, Plus, Trash2, ChevronUp, ChevronDown, Eye, EyeOff,
  Image as ImageIcon, Type, Video, ShoppingBag, Layers, Star,
  Timer, MousePointer, LayoutGrid, Zap, Heart, Phone, Save, Check, MapPin, Copy,
  Trophy, Award,
} from "lucide-react";
import SingleImageSelect from "@/components/block/ImageSelector";
import { STORE_MAP_DEFAULTS, linkCoordStatus, extractLatLng } from "@/lib/storeMap";
import StoreMapSection from "@/components/HomeBuilder/StoreMapSection";

// ── Section type definitions ──────────────────────────────────────────────────
const SECTION_TYPES = [
  { type: "hero",               icon: ImageIcon,    color: "from-purple-500 to-indigo-600",  label: "Hero Banner",         desc: "Large banner with title & CTA" },
  { type: "slider",             icon: Layers,       color: "from-blue-500 to-cyan-600",      label: "Slider",              desc: "Image carousel (uses Slider admin)" },
  { type: "collection_slider",  icon: LayoutGrid,   color: "from-teal-500 to-green-600",     label: "Collection Slider",   desc: "Horizontal collection cards" },
  { type: "products",           icon: ShoppingBag,  color: "from-orange-500 to-red-500",     label: "Products Grid",       desc: "Product cards grid" },
  { type: "collection_section", icon: LayoutGrid,   color: "from-pink-500 to-rose-600",      label: "Collection Sections", desc: "Homepage collection sections" },
  { type: "image",              icon: ImageIcon,    color: "from-green-500 to-emerald-600",  label: "Image",               desc: "Single image banner" },
  { type: "video",              icon: Video,        color: "from-red-500 to-orange-500",     label: "Video",               desc: "YouTube or uploaded video" },
  { type: "text",               icon: Type,         color: "from-gray-500 to-slate-600",     label: "Text Block",          desc: "Text or HTML content" },
  { type: "cta",                icon: MousePointer, color: "from-yellow-500 to-amber-600",   label: "Call to Action",      desc: "Button with title & subtitle" },
  { type: "countdown",          icon: Timer,        color: "from-violet-500 to-purple-600",  label: "Countdown",           desc: "Timer to a target date" },
  { type: "rating_badge",       icon: Star,         color: "from-blue-500 to-blue-700",      label: "Rating Badge",        desc: "Badge bleu avec note moyenne et nombre d'avis" },
  { type: "reviews",            icon: Star,         color: "from-yellow-400 to-orange-500",  label: "Reviews",             desc: "Customer feedback section" },
  { type: "support",            icon: Heart,        color: "from-cyan-500 to-blue-600",      label: "Support Benefits",    desc: "Trust badges section" },
  { type: "reels",              icon: Video,        color: "from-pink-500 to-fuchsia-600",   label: "Video Reels",         desc: "Short video reels" },
  { type: "shoppable_reels",    icon: ShoppingBag,  color: "from-violet-500 to-purple-600",  label: "Shoppable Videos",    desc: "Clickable videos linked to products" },
  { type: "before_after",       icon: Zap,          color: "from-rose-400 to-orange-400",    label: "Avant / Après",       desc: "Slider avant/après avec produit lié" },
  { type: "contact",            icon: Phone,        color: "from-slate-500 to-gray-700",     label: "Contact",             desc: "Contact info & social links" },
  { type: "store_map",          icon: MapPin,       color: "from-red-500 to-rose-600",       label: "📍 Store Map",        desc: "Google Map + store info & directions" },
  { type: "top_members",        icon: Trophy,       color: "from-amber-500 to-orange-600",   label: "Top Members (démo)",  desc: "Aperçu du classement démo des membres — simulation" },
  { type: "top_brands",         icon: Award,        color: "from-orange-500 to-red-600",     label: "Top Brands (démo)",   desc: "Aperçu du classement démo des marques — simulation" },
];

const TYPE_META = Object.fromEntries(SECTION_TYPES.map((t) => [t.type, t]));

// ── Default section data ──────────────────────────────────────────────────────
const DEFAULTS = {
  hero:               { title: "Welcome to our store", subtitle: "Discover amazing products at great prices", buttonText: "Shop Now", buttonUrl: "/products", image: "", overlayOpacity: 40 },
  slider:             {},
  collection_slider:  {},
  products:           { title: "Featured Products", limit: 8, collectionFilter: "" },
  collection_section: { collectionTitle: "", collectionId: "", productLimit: 8, customTitle: "", showViewMore: true, mode: "auto", selectedProducts: [] },
  image:              { url: "", link: "", alt: "" },
  video:              { url: "", autoplay: false, muted: true },
  text:               { content: "", align: "center" },
  cta:                { title: "Limited Time Offer", subtitle: "Don't miss out on exclusive deals", buttonText: "Shop Now", buttonUrl: "/products", bg: "#111827" },
  countdown:          { title: "Sale Ends In", targetDate: "", subtitle: "Hurry up before the deal expires!" },
  rating_badge:       {},
  reviews:            {},
  support:            {},
  reels:              {},
  contact:            { title: "Contact Us", phone: "", email: "", address: "" },
  store_map:          { ...STORE_MAP_DEFAULTS },
  top_members:        { title: "", previewCount: 5, showViewAll: true },
  top_brands:         { title: "", previewCount: 5, showViewAll: true },
};

let _seq = 0;
function uid() { return `sec_${Date.now()}_${++_seq}`; }

// ── Edit forms per section type ───────────────────────────────────────────────
function EditHero({ data, onChange }) {
  const [imgOpen, setImgOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Field label="Title"><input className="field" value={data.title || ""} onChange={e => onChange({ ...data, title: e.target.value })} /></Field>
      <Field label="Subtitle"><input className="field" value={data.subtitle || ""} onChange={e => onChange({ ...data, subtitle: e.target.value })} /></Field>
      <Field label="Button Text"><input className="field" value={data.buttonText || ""} onChange={e => onChange({ ...data, buttonText: e.target.value })} /></Field>
      <Field label="Button URL"><input className="field" value={data.buttonUrl || ""} onChange={e => onChange({ ...data, buttonUrl: e.target.value })} /></Field>
      <Field label="Overlay Opacity (0-100)"><input type="number" min={0} max={100} className="field w-24" value={data.overlayOpacity ?? 40} onChange={e => onChange({ ...data, overlayOpacity: Number(e.target.value) })} /></Field>
      <Field label="Background Image">
        <div className="flex gap-2 items-center">
          {data.image && <img src={data.image} alt="" className="h-12 w-20 object-cover rounded-md border" />}
          <button type="button" onClick={() => setImgOpen(true)} className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-md">{data.image ? "Change" : "Select Image"}</button>
          {data.image && <button type="button" onClick={() => onChange({ ...data, image: "" })} className="text-xs text-red-500 hover:text-red-700">Remove</button>}
        </div>
      </Field>
      <SingleImageSelect isOpen={imgOpen} onClose={() => setImgOpen(false)} onSelectImages={url => { onChange({ ...data, image: url }); setImgOpen(false); }} selectType="single" />
    </div>
  );
}

function EditProducts({ data, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Section Title"><input className="field" value={data.title || ""} onChange={e => onChange({ ...data, title: e.target.value })} /></Field>
      <Field label="Max Products"><input type="number" min={1} max={50} className="field w-24" value={data.limit || 8} onChange={e => onChange({ ...data, limit: Number(e.target.value) })} /></Field>
      <Field label="Filter by Collection (title, optional)"><input className="field" placeholder="e.g. Summer Sale" value={data.collectionFilter || ""} onChange={e => onChange({ ...data, collectionFilter: e.target.value })} /></Field>
    </div>
  );
}

function EditImage({ data, onChange }) {
  const [imgOpen, setImgOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Field label="Image">
        <div className="flex gap-2 items-center">
          {data.url && <img src={data.url} alt="" className="h-12 w-20 object-cover rounded-md border" />}
          <button type="button" onClick={() => setImgOpen(true)} className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-md">{data.url ? "Change" : "Select Image"}</button>
          {data.url && <button type="button" onClick={() => onChange({ ...data, url: "" })} className="text-xs text-red-500 hover:text-red-700">Remove</button>}
        </div>
      </Field>
      <Field label="Link URL (optional)"><input className="field" value={data.link || ""} onChange={e => onChange({ ...data, link: e.target.value })} /></Field>
      <Field label="Alt text"><input className="field" value={data.alt || ""} onChange={e => onChange({ ...data, alt: e.target.value })} /></Field>
      <SingleImageSelect isOpen={imgOpen} onClose={() => setImgOpen(false)} onSelectImages={url => { onChange({ ...data, url }); setImgOpen(false); }} selectType="single" />
    </div>
  );
}

function EditVideo({ data, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Video URL (YouTube or direct .mp4)"><input className="field" placeholder="https://youtube.com/watch?v=..." value={data.url || ""} onChange={e => onChange({ ...data, url: e.target.value })} /></Field>
      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={!!data.autoplay} onChange={e => onChange({ ...data, autoplay: e.target.checked })} /> Autoplay</label>
        <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={!!data.muted} onChange={e => onChange({ ...data, muted: e.target.checked })} /> Muted</label>
      </div>
    </div>
  );
}

function EditText({ data, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Content">
        <textarea className="field min-h-[100px]" value={data.content || ""} onChange={e => onChange({ ...data, content: e.target.value })} />
      </Field>
      <Field label="Alignment">
        <select className="field" value={data.align || "center"} onChange={e => onChange({ ...data, align: e.target.value })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </Field>
    </div>
  );
}

function EditCta({ data, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Title"><input className="field" value={data.title || ""} onChange={e => onChange({ ...data, title: e.target.value })} /></Field>
      <Field label="Subtitle"><input className="field" value={data.subtitle || ""} onChange={e => onChange({ ...data, subtitle: e.target.value })} /></Field>
      <Field label="Button Text"><input className="field" value={data.buttonText || ""} onChange={e => onChange({ ...data, buttonText: e.target.value })} /></Field>
      <Field label="Button URL"><input className="field" value={data.buttonUrl || ""} onChange={e => onChange({ ...data, buttonUrl: e.target.value })} /></Field>
      <Field label="Background Color"><input type="color" value={data.bg || "#111827"} onChange={e => onChange({ ...data, bg: e.target.value })} className="h-9 w-20 rounded border cursor-pointer" /></Field>
    </div>
  );
}

function EditCountdown({ data, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Title"><input className="field" value={data.title || ""} onChange={e => onChange({ ...data, title: e.target.value })} /></Field>
      <Field label="Subtitle"><input className="field" value={data.subtitle || ""} onChange={e => onChange({ ...data, subtitle: e.target.value })} /></Field>
      <Field label="Target Date & Time"><input type="datetime-local" className="field" value={data.targetDate || ""} onChange={e => onChange({ ...data, targetDate: e.target.value })} /></Field>
    </div>
  );
}

function EditContact({ data, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Title"><input className="field" value={data.title || ""} onChange={e => onChange({ ...data, title: e.target.value })} /></Field>
      <Field label="Phone"><input className="field" value={data.phone || ""} onChange={e => onChange({ ...data, phone: e.target.value })} /></Field>
      <Field label="Email"><input className="field" value={data.email || ""} onChange={e => onChange({ ...data, email: e.target.value })} /></Field>
      <Field label="Address"><input className="field" value={data.address || ""} onChange={e => onChange({ ...data, address: e.target.value })} /></Field>
    </div>
  );
}

function EditStoreMap({ data, onChange }) {
  const set = (k) => (e) => onChange({ ...data, [k]: e.target.value });
  const [locating, setLocating] = useState(false);
  const [located, setLocated]   = useState(null); // { ok, lat, lng, msg }

  // Any pasted Google Maps link is converted automatically — the admin never
  // has to know what an "embed URL" is.
  const status = linkCoordStatus(data.embedUrl);
  const pasted = (data.embedUrl || "").trim();

  // Works for EVERY link shape: coordinates already inside the URL are read
  // instantly, short links are resolved server-side (they are redirects).
  const locate = async () => {
    setLocating(true); setLocated(null);
    try {
      const local = extractLatLng(pasted);
      if (local) {
        onChange({ ...data, latitude: String(local.lat), longitude: String(local.lng) });
        setLocated({ ok: true, lat: local.lat, lng: local.lng });
        return;
      }
      const r = await fetch("/api/admin/store-map/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pasted }),
      });
      const d = await r.json();
      if (!r.ok) { setLocated({ ok: false, msg: d?.error || "Localisation impossible." }); return; }
      onChange({ ...data, latitude: d.latitude, longitude: d.longitude });
      setLocated({ ok: true, lat: d.latitude, lng: d.longitude });
    } catch {
      setLocated({ ok: false, msg: "Erreur réseau." });
    } finally { setLocating(false); }
  };

  const STATUS = {
    ok:            { cls: "text-green-700 bg-green-50 border-green-200", t: "✅ Coordonnées détectées dans le lien." },
    needs_resolve: { cls: "text-amber-800 bg-amber-50 border-amber-200", t: "🔗 Cliquez sur « Localiser automatiquement » pour extraire la position." },
    unsupported:   { cls: "text-red-700 bg-red-50 border-red-200",       t: "⚠️ Lien non exploitable. Utilisez « Localiser automatiquement » ou saisissez la latitude / longitude." },
  }[status];

  return (
    <div className="space-y-4">
      <Field label="Section Title"><input className="field" value={data.title || ""} onChange={set("title")} /></Field>
      <Field label="Subtitle"><input className="field" value={data.subtitle || ""} onChange={set("subtitle")} /></Field>

      {/* ── 📍 Google Maps ── */}
      <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 space-y-3">
        <p className="text-sm font-bold text-gray-900">📍 Google Maps</p>

        <input className="field" placeholder="Collez n'importe quel lien Google Maps ici…"
          value={data.embedUrl || ""} onChange={set("embedUrl")} />

        <button type="button" onClick={locate} disabled={locating || !pasted}
          className="w-full py-3 rounded-xl bg-gray-900 hover:bg-black text-white text-sm font-bold disabled:opacity-40 transition-colors">
          {locating ? "⏳ Récupération de la position…" : "📍 Localiser automatiquement"}
        </button>

        {located?.ok && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2.5">
            <p className="text-xs font-bold text-green-800">✅ Position détectée avec succès</p>
            <div className="grid grid-cols-2 gap-2 mt-1.5">
              <p className="text-[11px] text-green-700">Latitude<br /><strong className="text-green-900">{located.lat}</strong></p>
              <p className="text-[11px] text-green-700">Longitude<br /><strong className="text-green-900">{located.lng}</strong></p>
            </div>
          </div>
        )}
        {located && !located.ok && (
          <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">{located.msg}</p>
        )}
        {!located && STATUS && <p className={`text-[11px] border rounded-lg px-2 py-1.5 ${STATUS.cls}`}>{STATUS.t}</p>}

        <p className="text-[11px] text-gray-400">
          Google Maps → votre magasin → <strong>Partager</strong> → <strong>Copier le lien</strong>. La carte affichée utilise
          OpenStreetMap (aucune clé API) ; le lien sert uniquement à récupérer les coordonnées.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Latitude (secours)"><input className="field" placeholder="32.7644" value={data.latitude || ""} onChange={set("latitude")} /></Field>
          <Field label="Longitude (secours)"><input className="field" placeholder="-6.3986" value={data.longitude || ""} onChange={set("longitude")} /></Field>
        </div>
      </div>

      <Field label="Store Name"><input className="field" value={data.storeName || ""} onChange={set("storeName")} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Store Address"><input className="field" value={data.address || ""} onChange={set("address")} /></Field>
        <Field label="City"><input className="field" placeholder="Boujad, Morocco" value={data.city || ""} onChange={set("city")} /></Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Phone Number"><input className="field" value={data.phone || ""} onChange={set("phone")} /></Field>
        <Field label="Working Hours"><input className="field" placeholder="Mon–Sat • 09:00–20:00" value={data.hours || ""} onChange={set("hours")} /></Field>
        <Field label="Rating (0–5)"><input className="field" placeholder="4.9" value={data.rating ?? ""} onChange={set("rating")} /></Field>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Button Text"><input className="field" value={data.buttonText || ""} onChange={set("buttonText")} /></Field>
        <Field label="WhatsApp Button Text"><input className="field" value={data.whatsappText || ""} onChange={set("whatsappText")} /></Field>
        <Field label="Button URL (optional)"><input className="field" placeholder="Auto" value={data.buttonUrl || ""} onChange={set("buttonUrl")} /></Field>
      </div>

      <Field label="Message WhatsApp pré-rempli">
        <input className="field" dir="rtl" value={data.whatsappMessage ?? ""} onChange={set("whatsappMessage")}
          placeholder="السلام عليكم، بغيت نستفسر على المحل والمنتجات." />
        <p className="text-[11px] text-gray-400 mt-1">Le bouton WhatsApp utilise le numéro de téléphone ci-dessus (normalisé au format 212…). Il est masqué si aucun numéro n'est renseigné.</p>
      </Field>

      {/* Preview uses the EXACT storefront renderer — the two can never differ. */}
      <Field label="Aperçu (rendu réel de la boutique)">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <StoreMapSection data={data} adminPreview />
        </div>
      </Field>
    </div>
  );
}

function EditCollectionSection({ data, onChange }) {
  const [collections,  setCollections]  = useState([]);
  const [loadingCols,  setLoadingCols]  = useState(true);
  const [allProducts,  setAllProducts]  = useState([]);
  const [loadingProds, setLoadingProds] = useState(false);
  const [search,       setSearch]       = useState("");

  const mode             = data.mode || "auto";
  const selectedProducts = Array.isArray(data.selectedProducts) ? data.selectedProducts : [];

  // Always load collections (used in auto mode + optional view-more link)
  useEffect(() => {
    fetch("/api/collection", { cache: "no-store" })
      .then(r => r.ok ? r.json() : [])
      .then(d => setCollections(Array.isArray(d) ? d : []))
      .catch(() => setCollections([]))
      .finally(() => setLoadingCols(false));
  }, []);

  // Load products only when switching to manual mode
  useEffect(() => {
    if (mode !== "manual") return;
    setLoadingProds(true);
    fetch("/api/products", { cache: "no-store" })
      .then(r => r.ok ? r.json() : [])
      .then(d => setAllProducts(Array.isArray(d) ? d : []))
      .catch(() => setAllProducts([]))
      .finally(() => setLoadingProds(false));
  }, [mode]);

  const handleCollectionSelect = (e) => {
    const col = collections.find(c => (c._id || c.id) === e.target.value);
    onChange(col
      ? { ...data, collectionTitle: col.title, collectionId: col._id || col.id }
      : { ...data, collectionTitle: "", collectionId: "" }
    );
  };

  const addProduct = (id) => {
    if (selectedProducts.includes(id)) return;
    onChange({ ...data, selectedProducts: [...selectedProducts, id] });
  };

  const removeProduct = (id) => {
    onChange({ ...data, selectedProducts: selectedProducts.filter(x => x !== id) });
  };

  const moveProduct = (idx, dir) => {
    const arr = [...selectedProducts];
    const to = idx + dir;
    if (to < 0 || to >= arr.length) return;
    [arr[idx], arr[to]] = [arr[to], arr[idx]];
    onChange({ ...data, selectedProducts: arr });
  };

  // Build a lookup map for quick access
  const productMap = Object.fromEntries(allProducts.map(p => [p._id || p.id, p]));

  // Products not yet selected, filtered by search
  const available = allProducts
    .filter(p => !selectedProducts.includes(p._id || p.id))
    .filter(p => !search || (p.title || "").toLowerCase().includes(search.toLowerCase()))
    .slice(0, 60);

  const getImg = (p) => {
    const raw = p.images?.[0];
    return raw?.url || raw || null;
  };

  return (
    <div className="space-y-4">

      {/* ── Mode toggle ── */}
      <Field label="Selection Mode">
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {["auto", "manual"].map(m => (
            <button
              key={m}
              type="button"
              onClick={() => onChange({ ...data, mode: m })}
              className={`flex-1 py-2 text-xs font-semibold transition-colors
                ${mode === m ? "bg-gray-900 text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
            >
              {m === "auto" ? "🔄 Auto (from collection)" : "✋ Manual (pick products)"}
            </button>
          ))}
        </div>
      </Field>

      {/* ── AUTO mode ── */}
      {mode === "auto" && (
        <Field label="Collection">
          {loadingCols ? (
            <div className="field text-gray-400 text-xs">Loading…</div>
          ) : (
            <select className="field" value={data.collectionId || ""} onChange={handleCollectionSelect}>
              <option value="">— Select a collection —</option>
              {collections.map(c => (
                <option key={c._id || c.id} value={c._id || c.id}>{c.title}</option>
              ))}
            </select>
          )}
          {data.collectionTitle && (
            <p className="text-xs text-green-600 mt-1">✓ <strong>{data.collectionTitle}</strong></p>
          )}
        </Field>
      )}

      {/* ── MANUAL mode ── */}
      {mode === "manual" && (
        <div className="space-y-3">

          {/* Selected list */}
          {selectedProducts.length > 0 && (
            <Field label={`Selected products (${selectedProducts.length}) — drag order = display order`}>
              <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                {selectedProducts.map((id, idx) => {
                  const p = productMap[id];
                  if (!p) return null;
                  const img = getImg(p);
                  return (
                    <div key={id} className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                      <span className="text-gray-400 font-mono w-4 text-center">{idx + 1}</span>
                      {img && <img src={img} alt="" className="w-8 h-8 object-cover rounded flex-shrink-0" />}
                      <span className="flex-1 font-medium text-gray-800 line-clamp-1">{p.title}</span>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button type="button" onClick={() => moveProduct(idx, -1)} disabled={idx === 0}
                          className="px-1.5 py-1 hover:bg-gray-100 rounded disabled:opacity-30 text-gray-500">↑</button>
                        <button type="button" onClick={() => moveProduct(idx, 1)} disabled={idx === selectedProducts.length - 1}
                          className="px-1.5 py-1 hover:bg-gray-100 rounded disabled:opacity-30 text-gray-500">↓</button>
                        <button type="button" onClick={() => removeProduct(id)}
                          className="px-1.5 py-1 hover:bg-red-50 rounded text-red-400 hover:text-red-600">×</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Field>
          )}

          {/* Product picker */}
          <Field label="Add products">
            <input
              className="field mb-2"
              placeholder="Search by product name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              {loadingProds ? (
                <p className="text-xs text-gray-400 text-center py-4">Loading products…</p>
              ) : available.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">
                  {search ? "No products match your search." : "All products are already selected."}
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto divide-y divide-gray-50">
                  {available.map(p => {
                    const img = getImg(p);
                    return (
                      <button
                        key={p._id || p.id}
                        type="button"
                        onClick={() => addProduct(p._id || p.id)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-purple-50 transition-colors text-left"
                      >
                        {img
                          ? <img src={img} alt="" className="w-8 h-8 object-cover rounded flex-shrink-0" />
                          : <div className="w-8 h-8 bg-gray-100 rounded flex-shrink-0" />
                        }
                        <span className="flex-1 text-xs font-medium text-gray-700 line-clamp-1">{p.title}</span>
                        <span className="text-[11px] text-purple-600 font-semibold shrink-0">+ Add</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Field>
        </div>
      )}

      {/* ── Common fields ── */}
      <Field label="Section Title (optional override)">
        <input
          className="field"
          placeholder={mode === "manual" ? "e.g. Our Picks" : (data.collectionTitle || "Uses collection name")}
          value={data.customTitle || ""}
          onChange={e => onChange({ ...data, customTitle: e.target.value })}
        />
      </Field>

      <Field label="Max Products to Display">
        <input
          type="number" min={1} max={50}
          className="field w-24"
          value={data.productLimit || 8}
          onChange={e => onChange({ ...data, productLimit: Number(e.target.value) })}
        />
        {mode === "manual" && (
          <p className="text-xs text-gray-400 mt-1">
            Limits how many are shown — you can select more above and reorder freely.
          </p>
        )}
      </Field>

      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked={data.showViewMore !== false}
          onChange={e => onChange({ ...data, showViewMore: e.target.checked })}
        />
        Show "View More" button
      </label>
    </div>
  );
}

function EditShoppableReels({ data, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Section Title">
        <input className="field" placeholder="e.g. In Action" value={data.title || ""} onChange={e => onChange({ ...data, title: e.target.value })} />
      </Field>
      <p className="text-xs text-gray-400">Videos are managed in <a href="/admin/reel" className="text-purple-600 underline">Video Reels → Shoppable Videos</a></p>
    </div>
  );
}

function EditBeforeAfter({ data, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Titre de la section">
        <input className="field" placeholder="Des résultats visibles, une confiance ressentie." value={data.title || ""} onChange={e => onChange({ ...data, title: e.target.value })} />
      </Field>
      <p className="text-xs text-gray-400">Les fiches avant/après sont gérées dans <a href="/admin/reel" className="text-rose-600 underline">Admin Reels → Avant / Après</a></p>
    </div>
  );
}

// Demo Competition previews: title (empty = default "Top Membres" / "Top Marques" in the
// visitor's language), number of rows shown (1..max) and the "View all" link.
function EditDemoLeaderboard({ data, onChange, max, placeholder, page }) {
  const count = Math.min(max, Math.max(1, Number.parseInt(data.previewCount, 10) || 5));
  return (
    <div className="space-y-3">
      <Field label="Titre de la section (vide = titre par défaut)">
        <input className="field" placeholder={placeholder} value={data.title || ""} onChange={e => onChange({ ...data, title: e.target.value })} />
      </Field>
      <Field label={`Nombre affiché (1 à ${max})`}>
        <input type="number" min={1} max={max} className="field w-24" value={count}
          onChange={e => onChange({ ...data, previewCount: Math.min(max, Math.max(1, Number.parseInt(e.target.value, 10) || 1)) })} />
      </Field>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={data.showViewAll !== false} onChange={e => onChange({ ...data, showViewAll: e.target.checked })} /> Lien « Voir tout » vers {page}
      </label>
      <p className="text-xs text-gray-400">Données de démonstration (simulation) : la section l&apos;indique toujours aux visiteurs.</p>
    </div>
  );
}
function EditTopMembers(props) { return <EditDemoLeaderboard {...props} max={21} placeholder="Top Membres" page="/top-members" />; }
function EditTopBrands(props)  { return <EditDemoLeaderboard {...props} max={20} placeholder="Top Marques" page="/top-brands" />; }

const EDIT_FORMS = {
  hero: EditHero, products: EditProducts, image: EditImage,
  video: EditVideo, text: EditText, cta: EditCta,
  countdown: EditCountdown, contact: EditContact, store_map: EditStoreMap,
  collection_section: EditCollectionSection,
  shoppable_reels: EditShoppableReels,
  before_after: EditBeforeAfter,
  top_members: EditTopMembers,
  top_brands: EditTopBrands,
};

// ── Helper components ─────────────────────────────────────────────────────────
function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

// ── Layout API ────────────────────────────────────────────────────────────────
// Admin endpoint with an optimistic-concurrency revision, shared with Demo Competition → Homepage Settings:
// GET → { sections: Array|null, revision }; PUT { sections, revision } → 200 { sections, revision }
// | 409 { code: "LAYOUT_CONFLICT", sections, revision } | 400 { code: "INVALID_LAYOUT" }.
// (The public homepage keeps reading GET /api/setting?type=homepage_layout.)
const LAYOUT_URL = "/api/admin/homepage-layout";

const CONFLICT_TEXT = "La mise en page a été modifiée ailleurs (ex. Demo Competition → Homepage Settings). Rechargez pour récupérer la dernière version — vos modifications non enregistrées seraient perdues.";

async function layoutRequest(method = "GET", body) {
  try {
    const res = await fetch(LAYOUT_URL, {
      method,
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

const defaultSections = () => [
  { id: uid(), type: "slider",            visible: true, data: {} },
  { id: uid(), type: "products",          visible: true, data: { ...DEFAULTS.products } },
  { id: uid(), type: "collection_section",visible: true, data: {} },
  { id: uid(), type: "reviews",           visible: true, data: {} },
  { id: uid(), type: "support",           visible: true, data: {} },
];

// ── Main page ─────────────────────────────────────────────────────────────────
export default function HomepageBuilder() {
  const [sections,    setSections]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [saved,       setSaved]       = useState(false);
  const [addOpen,     setAddOpen]     = useState(false);
  const [editId,      setEditId]      = useState(null);
  const [revision,    setRevision]    = useState(null);  // layout revision the edits are based on
  const [conflict,    setConflict]    = useState(false); // 409: saved elsewhere meanwhile
  const [error,       setError]       = useState(null);  // load / save error (French)

  // ── Fetch ────────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    const r = await layoutRequest("GET");
    if (r.ok && typeof r.data?.revision === "string") {
      setSections(Array.isArray(r.data.sections) ? r.data.sections : defaultSections());
      setRevision(r.data.revision);
      setConflict(false);
      setError(null);
    } else {
      setError(r.status === 401 || r.status === 403
        ? "Session admin expirée — reconnectez-vous."
        : "Impossible de charger la mise en page : l'enregistrement est désactivé. Rechargez la page.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Save ─────────────────────────────────────────────────────────────────────
  const save = async () => {
    if (!revision || conflict) return;
    setSaving(true);
    setError(null);
    const r = await layoutRequest("PUT", { sections, revision });
    setSaving(false);
    if (r.ok && typeof r.data?.revision === "string") {
      setRevision(r.data.revision);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else if (r.status === 409 && r.data?.code === "LAYOUT_CONFLICT") {
      setConflict(true); // never overwrite silently: the admin reloads explicitly
    } else {
      setError(r.status === 401 || r.status === 403 ? "Session admin expirée — reconnectez-vous."
        : r.data?.code === "INVALID_LAYOUT" ? "Mise en page refusée par le serveur (format invalide) : rien n'a été enregistré."
          : r.status === 0 ? "Erreur réseau : la mise en page n'a pas été enregistrée."
            : `Échec de l'enregistrement (${r.status}) : la mise en page n'a pas été enregistrée.`);
    }
  };

  // ── Section ops ──────────────────────────────────────────────────────────────
  const addSection = (type) => {
    setSections(prev => [...prev, { id: uid(), type, visible: true, data: { ...(DEFAULTS[type] || {}) } }]);
    setAddOpen(false);
  };

  const remove = (id) => setSections(prev => prev.filter(s => s.id !== id));

  const toggle = (id) => setSections(prev => prev.map(s => s.id === id ? { ...s, visible: !s.visible } : s));

  const moveUp = (idx) => {
    if (idx === 0) return;
    setSections(prev => { const a = [...prev]; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; return a; });
  };

  const moveDown = (idx) => {
    setSections(prev => {
      if (idx >= prev.length - 1) return prev;
      const a = [...prev]; [a[idx], a[idx + 1]] = [a[idx + 1], a[idx]]; return a;
    });
  };

  const updateData = useCallback((id, data) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, data } : s));
  }, []);

  // Duplicate a section (new id, same type/data) — inserted right after it.
  const duplicate = (idx) => {
    setSections(prev => {
      const src = prev[idx];
      if (!src) return prev;
      const copy = { ...src, id: uid(), data: JSON.parse(JSON.stringify(src.data || {})) };
      const a = [...prev]; a.splice(idx + 1, 0, copy); return a;
    });
  };

  // Drag & drop reordering (makes the existing grip handle functional).
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const onDrop = (to) => {
    setSections(prev => {
      if (dragIdx === null || dragIdx === to) return prev;
      const a = [...prev];
      const [moved] = a.splice(dragIdx, 1);
      a.splice(to, 0, moved);
      return a;
    });
    setDragIdx(null); setOverIdx(null);
  };

  if (loading) return <div className="flex justify-center items-center h-60 text-gray-400 text-sm">Loading...</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-20">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Homepage Builder</h1>
          <p className="text-xs text-gray-500 mt-0.5">Add, reorder, and configure sections on your homepage</p>
        </div>
        <div className="flex items-center gap-3">
          <a href="/" target="_blank" className="text-xs text-gray-500 hover:text-gray-700 underline">Preview →</a>
          <button onClick={save} disabled={saving || !revision || conflict}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed ${saved ? "bg-green-500 text-white" : "bg-black text-white hover:bg-gray-800"}`}>
            {saved ? <><Check size={15} /> Saved!</> : saving ? "Saving..." : <><Save size={15} /> Save Layout</>}
          </button>
        </div>
      </div>

      {(conflict || error) && (
        <div className="max-w-4xl mx-auto px-4 pt-6 space-y-2">
          {conflict && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="flex-1 min-w-[220px]">{CONFLICT_TEXT}</span>
              <button onClick={load} className="px-4 py-2 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700">Recharger</button>
            </div>
          )}
          {error && (
            <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <span>{error}</span>
              {revision && <button onClick={() => setError(null)} className="font-bold opacity-60 hover:opacity-100" aria-label="Fermer">×</button>}
            </div>
          )}
        </div>
      )}

      <div className="max-w-4xl mx-auto px-4 py-8 flex gap-6">
        {/* Section List */}
        <div className="flex-1 space-y-3">
          {sections.length === 0 && (
            <div className="text-center py-16 bg-white rounded-2xl border-2 border-dashed border-gray-200">
              <LayoutGrid className="mx-auto mb-3 text-gray-300" size={40} />
              <p className="text-gray-500 font-medium">No sections yet</p>
              <p className="text-gray-400 text-sm mt-1">Click "Add Section" to get started</p>
            </div>
          )}

          {sections.map((sec, idx) => {
            const meta     = TYPE_META[sec.type] || {};
            const EditForm = EDIT_FORMS[sec.type] || null;
            const isEdit   = editId === sec.id;
            const Icon     = meta.icon || LayoutGrid;

            return (
              <div key={sec.id}
                draggable
                onDragStart={() => setDragIdx(idx)}
                onDragOver={(e) => { e.preventDefault(); if (overIdx !== idx) setOverIdx(idx); }}
                onDrop={(e) => { e.preventDefault(); onDrop(idx); }}
                onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                className={`bg-white rounded-2xl border transition-all ${sec.visible ? "border-gray-200 shadow-sm" : "border-gray-100 opacity-60"} ${isEdit ? "ring-2 ring-black" : ""} ${dragIdx === idx ? "opacity-40" : ""} ${overIdx === idx && dragIdx !== null && dragIdx !== idx ? "ring-2 ring-blue-400" : ""}`}>
                {/* Section Header */}
                <div className="flex items-center gap-3 px-4 py-3">
                  {/* Drag handle */}
                  <GripVertical size={16} className="text-gray-300 shrink-0 cursor-grab" />

                  {/* Icon */}
                  <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${meta.color || "from-gray-400 to-gray-600"} flex items-center justify-center shrink-0`}>
                    <Icon size={14} className="text-white" />
                  </div>

                  {/* Label */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{meta.label || sec.type}</p>
                    <p className="text-xs text-gray-400 truncate">{meta.desc || ""}</p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => moveUp(idx)} disabled={idx === 0}
                      className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-30 transition-colors">
                      <ChevronUp size={14} />
                    </button>
                    <button onClick={() => moveDown(idx)} disabled={idx === sections.length - 1}
                      className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-30 transition-colors">
                      <ChevronDown size={14} />
                    </button>
                    <button onClick={() => toggle(sec.id)}
                      className={`p-1.5 rounded-lg transition-colors ${sec.visible ? "hover:bg-gray-100 text-gray-600" : "hover:bg-yellow-50 text-yellow-500"}`}>
                      {sec.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                    <button onClick={() => duplicate(idx)} title="Duplicate"
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors">
                      <Copy size={14} />
                    </button>
                    {EditForm && (
                      <button onClick={() => setEditId(isEdit ? null : sec.id)}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${isEdit ? "bg-black text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
                        {isEdit ? "Done" : "Edit"}
                      </button>
                    )}
                    <button onClick={() => remove(sec.id)}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Edit Panel */}
                {isEdit && EditForm && (
                  <div className="border-t border-gray-100 px-4 py-4 bg-gray-50 rounded-b-2xl">
                    <EditForm data={sec.data} onChange={(data) => updateData(sec.id, data)} />
                  </div>
                )}
              </div>
            );
          })}

          {/* Add Section Button */}
          <button onClick={() => setAddOpen(!addOpen)}
            className="w-full flex items-center justify-center gap-2 py-3 bg-white border-2 border-dashed border-gray-300 rounded-2xl text-gray-500 hover:border-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-all text-sm font-semibold">
            <Plus size={16} /> Add Section
          </button>
        </div>

        {/* Section Type Picker (sidebar) */}
        {addOpen && (
          <div className="w-72 shrink-0">
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden sticky top-24">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <p className="text-sm font-bold text-gray-900">Choose Section</p>
                <button onClick={() => setAddOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
              </div>
              <div className="p-2 max-h-[70vh] overflow-y-auto space-y-1">
                {SECTION_TYPES.map(st => (
                  <button key={st.type} onClick={() => addSection(st.type)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50 transition-colors text-left">
                    <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${st.color} flex items-center justify-center shrink-0`}>
                      <st.icon size={14} className="text-white" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{st.label}</p>
                      <p className="text-xs text-gray-400">{st.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        .field {
          width: 100%;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 7px 10px;
          font-size: 13px;
          outline: none;
          background: white;
          transition: border-color 0.15s;
        }
        .field:focus { border-color: #6b7280; }
        textarea.field { resize: vertical; }
      `}</style>
    </div>
  );
}
