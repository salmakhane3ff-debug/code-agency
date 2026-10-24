"use client";

/**
 * /admin/demo-profiles — manage the DEMO competition profiles (fake personas used
 * by the demo leaderboard / Live Activity). Never real affiliates: real
 * affiliates live in /admin/affiliates and are not touched here.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Search, Plus, Users, AlertTriangle, X, ChevronRight } from "lucide-react";
import { validateProfileInput, MAX_GENERATE } from "@/lib/demoProfileValidation";
import { DemoBadge, DemoAvatar } from "./ui";

const fmtMoney = (n) => `${Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} MAD`;

function AddProfileModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", username: "", gender: "women", growthType: "consistent", city: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    const v = validateProfileInput(form); // same rules as the server
    if (!v.ok) { setError(v.error); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/admin/demo/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", profile: form }) });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Erreur"); return; }
      onCreated(d.profile);
    } catch { setError("Erreur réseau"); } finally { setBusy(false); }
  };

  const field = "w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400";
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">Nouveau profil <DemoBadge /></h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>
        {error && <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
        <input className={field} placeholder="Nom (ex. Salma Bennani)" value={form.name} onChange={(e) => set("name", e.target.value)} />
        <input className={field} placeholder="Nom d'utilisateur (ex. demo_salma42)" value={form.username} onChange={(e) => set("username", e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <select className={field} value={form.gender} onChange={(e) => set("gender", e.target.value)}>
            <option value="women">Femme</option><option value="men">Homme</option>
          </select>
          <select className={field} value={form.growthType} onChange={(e) => set("growthType", e.target.value)}>
            <option value="aggressive">Croissance forte</option><option value="consistent">Régulière</option><option value="slow">Lente</option>
          </select>
        </div>
        <input className={field} placeholder="Ville (optionnel)" value={form.city} onChange={(e) => set("city", e.target.value)} />
        <p className="text-[11px] text-gray-400">Le profil démarre le cycle en cours à 0. L'avatar se choisit ensuite dans la fiche.</p>
        <button disabled={busy} className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Créer le profil démo"}
        </button>
      </form>
    </div>
  );
}

export default function DemoProfilesPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [count, setCount] = useState(10);
  const [strategy, setStrategy] = useState("add");
  const [mode, setMode] = useState("mixed");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/admin/demo/profiles?status=${status}&q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Erreur");
      setData(d);
    } catch (e) { setError(e.message || "Erreur réseau"); } finally { setLoading(false); }
  };
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/demo/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate", count: Number(count), mode, strategy }) });
      const d = await r.json();
      if (!r.ok) { setMsg({ ok: false, t: d.error || "Erreur" }); return; }
      setMsg({ ok: true, t: `${d.target} profils actifs · ${d.created} créés · ${d.reactivated} réactivés · ${d.deactivated} masqués (aucun profil remplacé)` });
      await load();
    } catch { setMsg({ ok: false, t: "Erreur réseau" }); } finally { setBusy(false); }
  };

  const profiles = data?.profiles || [];
  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2"><Users className="w-5 h-5 text-indigo-600" /> Profils démo <DemoBadge /></h1>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">Personas fictives de la compétition démo et du Live Activity — ce ne sont pas des affiliés réels (gérés dans « Affiliates »). Statistiques et gains affichés : simulation uniquement.</p>
        </div>
        <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl"><Plus className="w-4 h-4" /> Ajouter un profil</button>
      </div>

      {/* Generation */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-600">Génération par lot — les profils existants et leurs identifiants sont toujours conservés</p>
        <div className="flex flex-wrap items-center gap-2">
          {[10, 50, 100].map((n) => (
            <button key={n} type="button" onClick={() => setCount(n)} className={`px-3 py-1.5 text-xs font-bold rounded-lg border ${Number(count) === n ? "bg-indigo-50 border-indigo-300 text-indigo-700" : "border-gray-200 text-gray-600"}`}>{n}</button>
          ))}
          <input type="number" min={1} max={MAX_GENERATE} value={count} onChange={(e) => setCount(e.target.value)} className="w-20 px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50" />
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50">
            <option value="add">Ajouter N profils</option>
            <option value="target">Ajuster à N profils actifs</option>
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value)} className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50">
            <option value="mixed">Mixte</option><option value="women">Femmes</option><option value="men">Hommes</option>
          </select>
          <button onClick={generate} disabled={busy} className="px-3 py-1.5 bg-gray-900 hover:bg-black text-white text-xs font-bold rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Générer"}
          </button>
        </div>
        <p className="text-[11px] text-gray-400">Les profils masqués sont réactivés en premier ; en réduisant le nombre, les profils en trop sont masqués, jamais supprimés.</p>
        {msg && <p className={`text-xs px-3 py-2 rounded-lg ${msg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>{msg.t}</p>}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher (nom, utilisateur, ville)" className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl bg-white" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-xl bg-white">
          <option value="all">Tous</option><option value="active">Actifs</option><option value="inactive">Masqués</option>
        </select>
        {data && <span className="text-xs text-gray-500">{data.counts.active} actifs / {data.counts.total} · cycle #{data.cycle.cycleNum}</span>}
      </div>

      {/* List */}
      {loading && !data ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
      ) : error ? (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3"><AlertTriangle className="w-4 h-4" /> {error} <button onClick={load} className="ml-auto underline">Réessayer</button></div>
      ) : profiles.length === 0 ? (
        <div className="text-center text-sm text-gray-500 bg-white border border-gray-100 rounded-2xl py-12">Aucun profil démo{q ? " ne correspond à la recherche" : " — utilisez la génération ou « Ajouter un profil »"}.</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="hidden md:grid grid-cols-[3rem_1fr_8rem_6rem_6rem_7rem_2rem] gap-3 px-4 py-2 text-[11px] font-semibold text-gray-500 border-b border-gray-100">
            <span>Rang</span><span>Profil</span><span>Ville</span><span>Statut</span><span>Commandes</span><span>CA (cycle)</span><span />
          </div>
          {profiles.map((p) => (
            <Link key={p.id} href={`/admin/demo-profiles/${p.id}`} className="grid grid-cols-[2.5rem_1fr_auto] md:grid-cols-[3rem_1fr_8rem_6rem_6rem_7rem_2rem] gap-3 items-center px-4 py-3 border-b border-gray-50 hover:bg-gray-50">
              <span className="text-sm font-black text-gray-700">{p.rank ? `#${p.rank}` : "—"}</span>
              <span className="flex items-center gap-3 min-w-0">
                <DemoAvatar p={p} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-gray-900 truncate">{p.name}</span>
                  <span className="block text-[11px] text-gray-400 truncate">@{p.username}<span className="md:hidden"> · {p.stats.totalOrders} cmd · {p.isActive ? "actif" : "masqué"}</span></span>
                </span>
              </span>
              <span className="hidden md:block text-xs text-gray-500 truncate">{p.city || "—"}</span>
              <span className="hidden md:block"><span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${p.isActive ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>{p.isActive ? "Actif" : "Masqué"}</span></span>
              <span className="hidden md:block text-sm text-gray-700">{p.stats.totalOrders}</span>
              <span className="hidden md:block text-sm text-gray-700">{fmtMoney(p.stats.totalRevenue)}</span>
              <ChevronRight className="w-4 h-4 text-gray-300" />
            </Link>
          ))}
        </div>
      )}

      {adding && <AddProfileModal onClose={() => setAdding(false)} onCreated={(p) => { setAdding(false); window.location.href = `/admin/demo-profiles/${p.id}`; }} />}
    </div>
  );
}
