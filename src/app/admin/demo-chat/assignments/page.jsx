"use client";

/**
 * /admin/demo-chat/assignments — DEMO Mini Chat assignments + global switch (Phase 3C-9B).
 * Simulation only. Which published journey version each demo profile plays, from which
 * Casablanca day 1, and whether it is enabled. All rules are enforced server-side
 * (demoChatAssignmentService); this page only reflects them. Admin UI language: French
 * (LTR); profile and journey names are user content and render with dir="auto" (Arabic
 * names display right-to-left).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ArrowLeft, Search, Power, PowerOff, Pencil, Eye, AlertTriangle, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { api, field, DemoBadge, SimulationBadge, ErrorBox, fmtDate } from "../ui";

const btn = "px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50 inline-flex items-center gap-1";

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div role="dialog" aria-modal="true" className="relative w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-black text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none" aria-label="Fermer">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function GlobalSwitch({ gates, confirmation, onChanged, onStale }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (enabled) => {
    setBusy(true); setError(null);
    try {
      await api("/api/admin/demo-chat/config", "PATCH", enabled ? { enabled: true, confirm: typed } : { enabled: false });
      setOpen(false); setTyped(""); await onChanged();
    } catch (e) { setError(e.message); if (e.status === 409) onStale(); } finally { setBusy(false); }
  };
  const on = gates.enabled;
  return (
    <div className={`p-4 rounded-2xl border ${on ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"} text-xs space-y-2`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-bold flex items-center gap-2 text-gray-900">
          {on ? <ShieldCheck className="w-4 h-4 text-emerald-600" /> : <ShieldOff className="w-4 h-4 text-amber-600" />}
          Mini Chat {on ? "visible pour les affiliés (conversations activées uniquement)" : "désactivé"}
        </p>
        {gates.setting
          ? <button type="button" disabled={busy} onClick={() => submit(false)} className={`${btn} bg-white border border-gray-200 text-gray-800`}><PowerOff className="w-3.5 h-3.5" /> Désactiver</button>
          : <button type="button" disabled={!gates.env} onClick={() => { setOpen(true); setError(null); }} className={`${btn} bg-indigo-600 text-white`} title={gates.env ? "" : "Variable serveur DEMO_CHAT_ENABLED ≠ true"}><Power className="w-3.5 h-3.5" /> Activer…</button>}
      </div>
      <p className="text-gray-700">
        Variable serveur DEMO_CHAT_ENABLED : <b>{gates.env ? "true" : "false"}</b> (non modifiable ici) · Paramètre protégé « demo-chat-config » : <b>{gates.setting ? "activé" : "désactivé"}</b>. Les deux sont requis.
      </p>
      {!gates.env && <p className="text-amber-800">Activation impossible tant que la variable serveur n'est pas « true ». La désactivation reste toujours possible.</p>}
      {!open && <ErrorBox error={error} />}
      {open && (
        <Modal title="Activer le Mini Chat (simulation)" onClose={() => setOpen(false)}>
          <p className="text-xs text-gray-700">Les conversations <b>activées</b> deviendront visibles pour tous les affiliés connectés, avec la mention « simulation ». Tapez <b>{confirmation}</b> pour confirmer.</p>
          <input className={field} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={confirmation} autoFocus aria-label="Confirmation" />
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className={`${btn} border border-gray-200 text-gray-700`}>Annuler</button>
            <button type="button" disabled={busy || typed !== confirmation} onClick={() => submit(true)} className={`${btn} bg-indigo-600 text-white`}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />} Activer</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AssignDialog({ profile, versions, anchor, onClose, onSaved, onStale }) {
  const a = profile.assignment;
  const [versionId, setVersionId] = useState(a && versions.some((v) => v.id === a.versionId) ? a.versionId : (versions[0]?.id || ""));
  const [anchorDate, setAnchorDate] = useState(a?.anchorDate || anchor.today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/api/admin/demo-chat/assignments/${encodeURIComponent(profile.id)}`, "PUT", { versionId, anchorDate, ...(a ? { expectedUpdatedAt: a.updatedAt } : {}) });
      await onSaved();
    } catch (e) { setError(e.message); if (e.code === "STALE" || e.code === "CONFLICT") onStale(); } finally { setBusy(false); }
  };
  return (
    <Modal title={a ? "Changer l'attribution" : "Attribuer un parcours"} onClose={onClose}>
      <p className="text-xs text-gray-600">Profil : <b dir="auto">{profile.name}</b></p>
      {a && (
        <p className="flex items-start gap-2 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Changer la version ou le jour 1 crée la révision {a.revision + 1}, <b>désactive</b> l'attribution et masque les messages déjà publiés (ils restent enregistrés).
        </p>
      )}
      {versions.length === 0
        ? <p className="text-xs text-gray-500">Aucune version publiée d'un parcours actif. Publiez d'abord un parcours.</p>
        : (
          <label className="block text-[11px] font-bold text-gray-600">Version publiée
            <select className={field} value={versionId} onChange={(e) => setVersionId(e.target.value)}>
              {versions.map((v) => <option key={v.id} value={v.id}>{v.journeyName} — v{v.version} ({v.stepCount} étape(s), {fmtDate(v.publishedAt)})</option>)}
            </select>
          </label>
        )}
      <label className="block text-[11px] font-bold text-gray-600">Jour 1 (calendrier de Casablanca)
        <input type="date" className={field} value={anchorDate} min={anchor.min} max={anchor.max} onChange={(e) => setAnchorDate(e.target.value)} />
      </label>
      <p className="text-[11px] text-gray-500">Entre {anchor.min} et {anchor.max}. Une nouvelle attribution est créée <b>désactivée</b>.</p>
      <ErrorBox error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} border border-gray-200 text-gray-700`}>Annuler</button>
        <button type="button" disabled={busy || !versionId} onClick={save} className={`${btn} bg-indigo-600 text-white`}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Enregistrer</button>
      </div>
    </Modal>
  );
}

function ProfileRow({ p, onEdit, onToggle, busy }) {
  const a = p.assignment;
  return (
    <div className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {p.avatarUrl
          ? <img src={p.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" /> // eslint-disable-line @next/next/no-img-element
          : <div className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-black" style={{ background: p.avatarColor || "#6366f1" }}>{(p.name || "?").slice(0, 1)}</div>}
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate" dir="auto">{p.name} {!p.isActive && <span className="ms-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px] font-bold">masqué</span>}</p>
          {a ? (
            <p className="text-[11px] text-gray-500">
              <span dir="auto">{a.version?.journeyName || "?"}</span> — v{a.version?.version ?? "?"}
              {a.version?.journeyStatus === "archived" && <span className="ms-1 text-amber-700 font-bold">(archivé)</span>}
              {" · "}jour 1 : {a.anchorDate} · révision {a.revision}
            </p>
          ) : <p className="text-[11px] text-gray-400">Aucune attribution</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {a && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${a.enabled ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-gray-100 text-gray-500"}`}>
            {a.enabled ? "ACTIVÉE" : "désactivée"}
          </span>
        )}
        {a && (
          <button type="button" disabled={busy || (!a.enabled && !p.isActive)} onClick={() => onToggle(p, !a.enabled)} className={`${btn} border border-gray-200 ${a.enabled ? "text-gray-700" : "text-emerald-700"}`}>
            {a.enabled ? <><PowerOff className="w-3.5 h-3.5" /> Désactiver</> : <><Power className="w-3.5 h-3.5" /> Activer</>}
          </button>
        )}
        <button type="button" disabled={busy || !p.isActive} onClick={() => onEdit(p)} className={`${btn} border border-gray-200 text-gray-700`} title={p.isActive ? "" : "Profil masqué"}>
          <Pencil className="w-3.5 h-3.5" /> {a ? "Changer" : "Attribuer"}
        </button>
        {a?.version && (
          <Link href={`/admin/demo-chat/${a.version.journeyId}/preview?version=${a.version.id}&profile=${encodeURIComponent(p.id)}&anchor=${a.anchorDate}`} className={`${btn} border border-gray-200 text-gray-700`}>
            <Eye className="w-3.5 h-3.5" /> Aperçu
          </Link>
        )}
      </div>
    </div>
  );
}

export default function DemoChatAssignmentsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status, ...(q.trim() ? { q: q.trim() } : {}) });
      setData(await api(`/api/admin/demo-chat/assignments?${qs}`)); setError(null);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [q, status]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const stale = () => { setNotice("Les données ont changé entre-temps : la liste a été rechargée."); load(); };

  const toggle = async (p, enabled) => {
    setBusyId(p.id); setNotice(null);
    try {
      const r = await api(`/api/admin/demo-chat/assignments/${encodeURIComponent(p.id)}`, "PATCH", { enabled, expectedUpdatedAt: p.assignment.updatedAt });
      if (r.unchanged) setNotice("Aucun changement.");
      await load();
    } catch (e) { setError(e.message); if (e.code === "STALE") stale(); } finally { setBusyId(null); }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
      <Link href="/admin/demo-chat" className="text-xs font-bold text-gray-500 hover:text-gray-900 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Parcours</Link>
      <h1 className="text-lg font-black text-gray-900 flex flex-wrap items-center gap-2">Attributions du Mini Chat <DemoBadge /> <SimulationBadge /></h1>
      <p className="text-xs text-gray-500">Conversations simulées de profils démo — jamais de vrais affiliés, commandes ou gains. Chaque profil joue au plus une version publiée.</p>

      {data && <GlobalSwitch gates={data.gates} confirmation={data.confirmation} onChanged={load} onStale={stale} />}
      {notice && <p className="text-xs text-indigo-800 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2">{notice}</p>}
      {error && (
        <div className="flex items-center gap-2">
          <div className="flex-1"><ErrorBox error={error} /></div>
          <button type="button" onClick={load} className={`${btn} border border-gray-200 text-gray-700`}><RefreshCw className="w-3.5 h-3.5" /> Réessayer</button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute start-3 top-2.5" />
          <input className={`${field} ps-9`} placeholder="Rechercher un profil (nom ou identifiant)" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" />
        </div>
        <select className={`${field} sm:max-w-[12rem]`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Profils actifs</option>
          <option value="all">Tous les profils</option>
        </select>
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white divide-y divide-gray-50">
        {loading && !data && <div className="p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>}
        {data && data.profiles.length === 0 && <p className="p-6 text-sm text-gray-500 text-center">Aucun profil démo{q ? " pour cette recherche" : ""}.</p>}
        {data?.profiles.map((p) => <ProfileRow key={p.id} p={p} busy={busyId === p.id} onEdit={setEditing} onToggle={toggle} />)}
      </div>
      {data?.truncated && <p className="text-[11px] text-gray-400">Liste limitée : affinez la recherche.</p>}

      {editing && data && (
        <AssignDialog profile={editing} versions={data.versions} anchor={data.anchor}
          onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); setNotice("Attribution enregistrée (désactivée)."); await load(); }}
          onStale={() => { setEditing(null); stale(); }} />
      )}
    </div>
  );
}
