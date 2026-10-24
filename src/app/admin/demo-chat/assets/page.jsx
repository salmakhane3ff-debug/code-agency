"use client";

/**
 * /admin/demo-chat/assets — DEMO chat media library (Phase 3C-3): upload images
 * and voice notes (checked from their actual content on the server), see where
 * each is used, delete unused ones. Simulation media only.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ArrowLeft, Upload, Trash2, Image as ImageIcon, Mic } from "lucide-react";
import { MEDIA_HINT, IMAGE_MAX_UPLOAD_BYTES, AUDIO_MAX_BYTES } from "@/lib/demoChatValidation";
import { field, DemoBadge, SimulationBadge, ErrorBox, fmtDate, fmtBytes, fmtDur, AssetThumb } from "../ui";

export default function DemoChatAssetsPage() {
  const [assets, setAssets] = useState(null);
  const [kind, setKind] = useState("image");
  const [filter, setFilter] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = async () => {
    try {
      const r = await fetch(`/api/admin/demo-chat/assets${filter ? `?kind=${filter}` : ""}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Erreur");
      setAssets(d.assets); setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!file) { setError("Choisissez un fichier."); return; }
    const max = kind === "audio" ? AUDIO_MAX_BYTES : IMAGE_MAX_UPLOAD_BYTES;
    if (file.size > max) { setError(kind === "audio" ? "Note vocale trop lourde (5 Mo max)." : "Image trop lourde (10 Mo max)."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const fd = new FormData(); fd.append("kind", kind); fd.append("file", file);
      const r = await fetch("/api/admin/demo-chat/assets", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Erreur");
      setNotice(d.deduplicated ? "Ce fichier existe déjà dans la bibliothèque." : "Média ajouté.");
      setFile(null); form.reset(); await load();
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  };

  const remove = async (a) => {
    if (!window.confirm("Supprimer définitivement ce média ?")) return;
    try {
      const r = await fetch(`/api/admin/demo-chat/assets/${a.id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Erreur");
      setNotice("Média supprimé."); await load();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      <Link href="/admin/demo-chat" className="text-xs font-bold text-gray-500 hover:text-gray-900 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Parcours</Link>
      <h1 className="text-lg font-black text-gray-900 flex flex-wrap items-center gap-2">Médias du chat démo <DemoBadge /> <SimulationBadge /></h1>
      <ErrorBox error={error} />
      {notice && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{notice}</p>}

      <form onSubmit={upload} className="p-4 rounded-2xl border border-gray-100 bg-white space-y-2">
        <h2 className="text-sm font-bold text-gray-900">Ajouter un média</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="image">Image</option><option value="audio">Note vocale</option>
          </select>
          <input type="file" className={`${field} sm:col-span-2`} accept={kind === "image" ? "image/jpeg,image/png,image/webp" : "audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg"} onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <p className="text-[11px] text-gray-400">{MEDIA_HINT} Le contenu réel du fichier est vérifié côté serveur ; le nom et le type annoncés sont ignorés.</p>
        <button disabled={busy} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl disabled:opacity-50 flex items-center gap-2">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Téléverser
        </button>
      </form>

      <select className={`${field} max-w-xs`} value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="">Tous les médias</option><option value="image">Images</option><option value="audio">Notes vocales</option>
      </select>
      {!assets && !error && <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />}
      {assets && assets.length === 0 && <p className="text-sm text-gray-500">Aucun média.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {assets?.map((a) => (
          <div key={a.id} className="p-3 rounded-2xl border border-gray-100 bg-white space-y-2">
            <AssetThumb asset={a} />
            <p className="text-[11px] text-gray-500 flex items-center gap-1">
              {a.kind === "image" ? <ImageIcon className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              {a.kind === "image" ? `${a.width}×${a.height}` : fmtDur(a.durationSec)} · {fmtBytes(a.bytes)} · {a.formatDetected} · {fmtDate(a.createdAt)}
            </p>
            <p className="text-[11px] text-gray-500">Utilisé : {a.usage.steps} brouillon(s), {a.usage.versions} version(s), {a.usage.messages} message(s)</p>
            <button disabled={!a.deletable} onClick={() => remove(a)} title={a.deletable ? "Supprimer" : "Utilisé : suppression impossible"} className="px-3 py-1.5 border border-red-200 text-red-700 text-xs font-bold rounded-lg flex items-center gap-1 disabled:opacity-40"><Trash2 className="w-3.5 h-3.5" /> Supprimer</button>
          </div>
        ))}
      </div>
    </div>
  );
}
