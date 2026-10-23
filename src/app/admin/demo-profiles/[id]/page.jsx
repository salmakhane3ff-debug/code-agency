"use client";

/**
 * /admin/demo-profiles/:id — one DEMO profile (fake persona, not a real affiliate):
 * identity editing, current-cycle score (leaderboard rule), 90-day DEMO earnings
 * history (stored rows only; optional one-time deterministic backfill) and the
 * archived cycles it appeared in. Chat (Phase 3C) is not enabled.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Loader2, ArrowLeft, AlertTriangle, Save, Trash2, EyeOff, Eye, Pencil, Check, X, Lock } from "lucide-react";
import { validateProfileInput, validateHistoryEdit } from "@/lib/demoProfileValidation";
import { DemoBadge, DemoAvatar } from "../ui";

const fmtMoney = (n) => `${Number(n || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD`;
const fmtDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const STATUS = {
  simulated:  { label: "Simulé",   cls: "bg-indigo-50 text-indigo-700" },
  backfilled: { label: "Complété", cls: "bg-amber-50 text-amber-700" },
  edited:     { label: "Modifié",  cls: "bg-gray-100 text-gray-700" },
};
const field = "w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400";

async function api(url, method, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "Erreur"), { status: r.status, code: d.code });
  return d;
}

function HistoryRow({ d, onSave }) {
  const [edit, setEdit] = useState(false);
  const [orders, setOrders] = useState(String(d.orders));
  const [revenue, setRevenue] = useState(String(d.revenue));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const v = validateHistoryEdit({ historyId: d.id, orders: Number(orders), revenue: Number(revenue) });
    if (!v.ok) { setErr(v.error); return; }
    setBusy(true); setErr(null);
    try { await onSave(v.value); setEdit(false); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const st = STATUS[d.status] || STATUS.simulated;
  return (
    <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[11rem_5rem_8rem_7rem_6rem_4rem] gap-2 items-center px-4 py-2.5 border-b border-gray-50 text-sm">
      <span className="text-gray-700">{fmtDay(d.day)}</span>
      {edit ? (
        <>
          <input type="number" min={0} value={orders} onChange={(e) => setOrders(e.target.value)} className="px-2 py-1 border border-gray-200 rounded-lg w-full" aria-label="Commandes" />
          <input type="number" min={0} step="0.01" value={revenue} onChange={(e) => setRevenue(e.target.value)} className="px-2 py-1 border border-gray-200 rounded-lg w-full" aria-label="Chiffre d'affaires" />
          <span className="text-xs text-gray-400">5 % recalculé</span>
          <span />
          <span className="flex gap-1">
            <button onClick={save} disabled={busy} className="p-1 text-green-600" aria-label="Enregistrer">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}</button>
            <button onClick={() => { setEdit(false); setErr(null); setOrders(String(d.orders)); setRevenue(String(d.revenue)); }} className="p-1 text-gray-400" aria-label="Annuler"><X className="w-4 h-4" /></button>
          </span>
          {err && <span className="col-span-full text-xs text-red-600">{err}</span>}
        </>
      ) : (
        <>
          <span className="text-gray-700 text-right sm:text-left">{d.orders} cmd</span>
          <span className="hidden sm:block text-gray-700">{fmtMoney(d.revenue)}</span>
          <span className="hidden sm:block text-gray-500">{fmtMoney(d.commission)}</span>
          <span className="hidden sm:block"><span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span></span>
          {d.editable ? (
            <button onClick={() => setEdit(true)} className="hidden sm:block p-1 text-gray-400 hover:text-gray-700" aria-label="Modifier"><Pencil className="w-4 h-4" /></button>
          ) : (
            // Today's row still receives simulated orders → editable from tomorrow (server enforces it too).
            <span className="hidden sm:block p-1 text-gray-300" title="Aujourd'hui : la simulation ajoute encore des commandes — modifiable à partir de demain"><Lock className="w-4 h-4" /></span>
          )}
          {!d.editable && <span className="col-span-full text-[11px] text-gray-400">Jour en cours : non modifiable (la simulation y ajoute encore des commandes), modifiable à partir de demain.</span>}
        </>
      )}
    </div>
  );
}

export default function DemoProfileDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [avatars, setAvatars] = useState([]);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const apply = (detail) => {
    setD(detail);
    const p = detail.profile;
    setForm({ name: p.name, username: p.username, gender: p.gender || "women", growthType: p.growthType, city: p.city || "", avatarUrl: p.avatarUrl, avatarColor: p.avatarColor });
  };
  const load = async () => {
    setError(null);
    try { apply(await api(`/api/admin/demo/profiles/${id}`, "GET")); }
    catch (e) { setError(e.status === 404 ? "Profil démo introuvable." : e.status === 400 ? "Identifiant invalide." : e.message); }
  };
  useEffect(() => {
    load();
    fetch("/api/admin/demo/avatars").then((r) => r.json()).then((x) => setAvatars(x.avatars || [])).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key, fn, okText) => {
    setBusy(key); setMsg(null);
    try { const out = await fn(); if (okText) setMsg({ ok: true, t: okText(out) }); return out; }
    catch (e) { setMsg({ ok: false, t: e.message }); return null; }
    finally { setBusy(null); }
  };

  const save = () => {
    const p = d.profile;
    const patch = {};
    for (const k of ["name", "username", "gender", "growthType", "avatarUrl", "avatarColor"]) if (form[k] !== p[k]) patch[k] = form[k];
    if ((form.city || "") !== (p.city || "")) patch.city = form.city;
    if (!Object.keys(patch).length) { setMsg({ ok: true, t: "Aucune modification." }); return; }
    const v = validateProfileInput(patch, { partial: true, avatarAllowed: () => true });
    if (!v.ok) { setMsg({ ok: false, t: v.error }); return; }
    run("save", async () => apply(await api(`/api/admin/demo/profiles/${id}`, "PATCH", patch)), () => "Profil enregistré ✓ (historique conservé)");
  };
  const toggleActive = () => run("active", async () => apply(await api(`/api/admin/demo/profiles/${id}`, "PATCH", { isActive: !d.profile.isActive })),
    () => (d.profile.isActive ? "Profil masqué (conservé, réactivable)" : "Profil réactivé"));
  const remove = async () => {
    if (!confirm("Supprimer définitivement ce profil démo ? (possible seulement s'il n'a aucun historique)")) return;
    const out = await run("delete", () => api(`/api/admin/demo/profiles/${id}`, "DELETE"));
    if (out?.deleted) router.push("/admin/demo-profiles");
  };
  const backfill = () => run("backfill", async () => { const r = await api(`/api/admin/demo/profiles/${id}/history`, "POST", { action: "backfill" }); await load(); return r; },
    (r) => (r.created ? `${r.created} jour(s) complété(s) avec des données démo stables` : "Aucun jour manquant"));
  const saveHistory = async (value) => apply(await api(`/api/admin/demo/profiles/${id}/history`, "PATCH", value));

  if (error) return (
    <div className="p-6 space-y-3">
      <Link href="/admin/demo-profiles" className="inline-flex items-center gap-1 text-xs text-gray-500"><ArrowLeft className="w-4 h-4" /> Profils démo</Link>
      <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3"><AlertTriangle className="w-4 h-4" /> {error}</div>
    </div>
  );
  if (!d || !form) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;

  const p = d.profile, c = d.currentCycle, h = d.history;
  const libForGender = avatars.filter((a) => !form.gender || a.gender === form.gender);
  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-5xl">
      <Link href="/admin/demo-profiles" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800"><ArrowLeft className="w-4 h-4" /> Profils démo</Link>

      <div className="flex flex-wrap items-center gap-3">
        <DemoAvatar p={{ ...p, ...form }} size={56} />
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2 flex-wrap">{p.name} <DemoBadge />
            {!p.isActive && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Masqué</span>}</h1>
          <p className="text-xs text-gray-500">@{p.username} · ID stable <code className="text-[11px]">{p.id}</code></p>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={toggleActive} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
            {p.isActive ? <><EyeOff className="w-4 h-4" /> Masquer</> : <><Eye className="w-4 h-4" /> Réactiver</>}
          </button>
          <button onClick={remove} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="w-4 h-4" /> Supprimer</button>
        </div>
      </div>
      {msg && <p className={`text-xs px-3 py-2 rounded-lg ${msg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>{msg.t}</p>}

      {/* Identity */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-600">Identité du profil démo</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-[11px] text-gray-500">Nom<input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="text-[11px] text-gray-500">Nom d'utilisateur<input className={field} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label className="text-[11px] text-gray-500">Ville<input className={field} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="—" /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-gray-500">Genre<select className={field} value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}><option value="women">Femme</option><option value="men">Homme</option></select></label>
            <label className="text-[11px] text-gray-500">Croissance<select className={field} value={form.growthType} onChange={(e) => setForm({ ...form, growthType: e.target.value })}><option value="aggressive">Forte</option><option value="consistent">Régulière</option><option value="slow">Lente</option></select></label>
          </div>
        </div>
        <div>
          <p className="text-[11px] text-gray-500 mb-1.5">Avatar (bibliothèque démo) — ou initiales</p>
          <div className="flex flex-wrap gap-2 items-center">
            <button type="button" onClick={() => setForm({ ...form, avatarUrl: null })} className={`w-10 h-10 rounded-full border-2 flex items-center justify-center text-xs font-bold ${form.avatarUrl === null ? "border-indigo-500" : "border-transparent"}`} style={{ background: form.avatarColor }} aria-label="Initiales">{(form.name || "?").slice(0, 1)}</button>
            <input type="color" value={form.avatarColor} onChange={(e) => setForm({ ...form, avatarColor: e.target.value })} className="w-8 h-8 rounded" aria-label="Couleur" />
            {libForGender.map((a) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={a.id} src={a.url} alt="" onClick={() => setForm({ ...form, avatarUrl: a.url })} className={`w-10 h-10 rounded-full object-cover cursor-pointer border-2 ${form.avatarUrl === a.url ? "border-indigo-500" : "border-transparent"}`} />
            ))}
            {libForGender.length === 0 && <span className="text-[11px] text-gray-400">Bibliothèque vide pour ce genre</span>}
          </div>
        </div>
        <button onClick={save} disabled={!!busy} className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl disabled:opacity-50">
          {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Enregistrer
        </button>
      </div>

      {/* Current cycle */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4">
        <p className="text-xs font-semibold text-gray-600 mb-3">Cycle en cours #{c.cycleNum} — score du classement (remis à zéro à chaque cycle)</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          {[["Rang", c.rank ? `#${c.rank}` : "—"], ["Commandes", c.stats.totalOrders], ["CA", fmtMoney(c.stats.totalRevenue)], ["Équipe", c.stats.teamSize]].map(([k, v]) => (
            <div key={k} className="bg-gray-50 rounded-xl py-3"><p className="text-base font-black text-gray-800">{v}</p><p className="text-[11px] text-gray-500">{k}</p></div>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 mt-2">Même règle de classement que le leaderboard public (commandes, puis CA, puis identifiant).</p>
      </div>

      {/* 90-day history */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
          <div>
            <p className="text-xs font-semibold text-gray-600">Historique des gains démo — 90 derniers jours ({h.from} → {h.to})</p>
            <p className="text-[11px] text-gray-400">Données simulées, distinctes du score du cycle. Une ligne par jour (heure non enregistrée).</p>
          </div>
          <button onClick={backfill} disabled={!!busy} className="px-3 py-1.5 text-xs font-bold rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
            {busy === "backfill" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Compléter les jours manquants"}
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 py-3 bg-gray-50 text-center">
          {[["Jours", h.totals.days], ["Commandes", h.totals.orders], ["CA", fmtMoney(h.totals.revenue)], ["Commission (5 %)", fmtMoney(h.totals.commission)]].map(([k, v]) => (
            <div key={k}><p className="text-sm font-black text-gray-800">{v}</p><p className="text-[11px] text-gray-500">{k} (total affiché)</p></div>
          ))}
        </div>
        {h.days.length === 0 ? (
          <p className="text-center text-sm text-gray-500 py-10">Aucune activité démo enregistrée sur 90 jours.</p>
        ) : (
          <>
            <div className="hidden sm:grid grid-cols-[11rem_5rem_8rem_7rem_6rem_4rem] gap-2 px-4 py-2 text-[11px] font-semibold text-gray-500 border-b border-gray-100">
              <span>Date</span><span>Commandes</span><span>CA</span><span>Commission</span><span>Statut</span><span />
            </div>
            {h.days.map((x) => <HistoryRow key={x.id} d={x} onSave={saveHistory} />)}
          </>
        )}
      </div>

      {/* Archived cycles */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4">
        <p className="text-xs font-semibold text-gray-600 mb-2">Cycles archivés</p>
        {d.cycles.length === 0 ? <p className="text-xs text-gray-400">Aucun cycle archivé pour ce profil.</p> : d.cycles.map((x) => (
          <p key={x.cycleNum} className="text-xs text-gray-600 py-1">#{x.cycleNum} · {new Date(x.startDate).toLocaleDateString("fr-FR")} → {new Date(x.endDate).toLocaleDateString("fr-FR")} · rang #{x.rank} · {x.totalOrders} cmd · {x.reason === "manual" ? "manuel" : "auto"}</p>
        ))}
      </div>

      <p className="text-[11px] text-gray-400">Chat : non activé (préparé pour une phase ultérieure — identifiant de profil stable ci-dessus).</p>
    </div>
  );
}
