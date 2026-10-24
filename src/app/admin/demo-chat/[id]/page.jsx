"use client";

/**
 * /admin/demo-chat/:id — edit one DEMO chat journey (Phase 3C-2): header,
 * draft steps (text / earnings; image & audio arrive with asset upload in
 * 3C-3), publish as an immutable version, version history, preview links.
 * Every write sends the journey's updatedAt; a 409 means someone else edited it.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Loader2, ArrowLeft, Save, Trash2, Archive, ArchiveRestore, Send, Eye, Pencil, X, Plus } from "lucide-react";
import {
  validateJourneyInput, validateStepInput, EARNINGS_PERIODS, EARNINGS_METRICS, JOURNEY_DAYS,
  MEDIA_DEFERRED_MSG, PLACEHOLDERS,
} from "@/lib/demoChatValidation";
import { api, field, DemoBadge, SimulationBadge, ErrorBox, STATUS_LABEL, TYPE_LABEL, PERIOD_LABEL, METRIC_LABEL, fmtDate } from "../ui";

const EMPTY_STEP = { day: 1, time: "09:00", position: 0, type: "text", text: "", earningsPeriod: "yesterday", metric: "commission" };

const toPayload = (f) => {
  const base = { day: Number(f.day), time: f.time, position: Number(f.position) || 0, type: f.type, text: f.text };
  return f.type === "earnings" ? { ...base, earningsPeriod: f.earningsPeriod, metric: f.metric } : { ...base, earningsPeriod: null, metric: null };
};

function StepForm({ initial, readOnly, onSubmit, onCancel, submitLabel }) {
  const [f, setF] = useState({ ...EMPTY_STEP, ...initial });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    const payload = toPayload(f);
    const v = validateStepInput(payload); // same rules as the server
    if (!v.ok) { setError(v.error); return; }
    setBusy(true); setError(null);
    try { await onSubmit(payload); } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="p-3 rounded-xl border border-gray-100 bg-gray-50/60 space-y-2">
      <ErrorBox error={error} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <label className="text-[11px] text-gray-500">Jour (1–{JOURNEY_DAYS})
          <input type="number" min={1} max={JOURNEY_DAYS} className={field} value={f.day} onChange={(e) => set("day", e.target.value)} disabled={readOnly} />
        </label>
        <label className="text-[11px] text-gray-500">Heure (Casablanca)
          <input type="time" className={field} value={f.time} onChange={(e) => set("time", e.target.value)} disabled={readOnly} />
        </label>
        <label className="text-[11px] text-gray-500">Ordre (même minute)
          <input type="number" min={0} max={99} className={field} value={f.position} onChange={(e) => set("position", e.target.value)} disabled={readOnly} />
        </label>
        <label className="text-[11px] text-gray-500">Type
          <select className={field} value={f.type} onChange={(e) => set("type", e.target.value)} disabled={readOnly}>
            <option value="text">Texte</option>
            <option value="earnings">Gains (valeurs simulées)</option>
            <option value="image" disabled>Image — phase 3C-3</option>
            <option value="audio" disabled>Audio — phase 3C-3</option>
          </select>
        </label>
      </div>
      {f.type === "earnings" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-gray-500">Période
            <select className={field} value={f.earningsPeriod} onChange={(e) => set("earningsPeriod", e.target.value)} disabled={readOnly}>
              {EARNINGS_PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}{p === "today" ? " (à partir de 12:00)" : ""}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-gray-500">Indicateur
            <select className={field} value={f.metric} onChange={(e) => set("metric", e.target.value)} disabled={readOnly}>
              {EARNINGS_METRICS.map((m) => <option key={m} value={m}>{METRIC_LABEL[m]}</option>)}
            </select>
          </label>
        </div>
      )}
      <textarea className={field} rows={3} value={f.text} onChange={(e) => set("text", e.target.value)} disabled={readOnly}
        placeholder={f.type === "earnings" ? `Ex. « Bravo, {amount} de commission {period} ! » — variables : ${PLACEHOLDERS.join(" ")}` : "Message texte (sans montant ni nombre de commandes)"} />
      <p className="text-[11px] text-gray-400">
        {f.type === "earnings"
          ? `Variables autorisées : ${PLACEHOLDERS.join(" ")} — ${f.metric === "orders" ? "{orders}" : "{amount}"} obligatoire. Les valeurs viennent de la simulation, jamais saisies à la main.`
          : "Aucun montant ni nombre de commandes saisi à la main."} {MEDIA_DEFERRED_MSG}
      </p>
      {!readOnly && (
        <div className="flex gap-2">
          <button disabled={busy} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg disabled:opacity-50 flex items-center gap-1">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} {submitLabel}
          </button>
          {onCancel && <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs font-bold text-gray-600 hover:text-gray-900 flex items-center gap-1"><X className="w-3.5 h-3.5" /> Annuler</button>}
        </div>
      )}
    </form>
  );
}

export default function DemoChatJourneyPage() {
  const { id } = useParams();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [header, setHeader] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await api(`/api/admin/demo-chat/journeys/${id}`);
      setData(d); setHeader({ name: d.journey.name, description: d.journey.description || "" }); setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const token = data?.journey.updatedAt;
  const readOnly = data?.journey.status !== "draft";
  const byDay = useMemo(() => {
    const m = new Map();
    for (const s of data?.steps || []) { if (!m.has(s.day)) m.set(s.day, []); m.get(s.day).push(s); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [data]);

  // Apply a write; on a stale token reload so the admin sees the other change.
  const run = async (fn, okMsg) => {
    setBusy(true); setNotice(null);
    try { const d = await fn(); if (d?.journey) { setData(d); setHeader({ name: d.journey.name, description: d.journey.description || "" }); } setError(null); if (okMsg) setNotice(okMsg); return d; }
    catch (e) { setError(e.message); if (e.code === "STALE") await load(); throw e; }
    finally { setBusy(false); }
  };

  const saveHeader = (e) => {
    e.preventDefault();
    const v = validateJourneyInput(header, { partial: true });
    if (!v.ok) { setError(v.error); return; }
    run(() => api(`/api/admin/demo-chat/journeys/${id}`, "PATCH", { expectedUpdatedAt: token, ...header }), "Enregistré.").catch(() => {});
  };
  const archive = (action) => run(() => api(`/api/admin/demo-chat/journeys/${id}`, "PATCH", { expectedUpdatedAt: token, action }), action === "archive" ? "Archivé." : "Réactivé.").catch(() => {});
  const remove = async () => {
    if (!window.confirm("Supprimer définitivement ce brouillon jamais publié ?")) return;
    try { await run(() => api(`/api/admin/demo-chat/journeys/${id}`, "DELETE", { expectedUpdatedAt: token })); router.push("/admin/demo-chat"); } catch { /* shown */ }
  };
  const publish = () => {
    if (!window.confirm("Publier une nouvelle version figée ? (aucune attribution aux profils, le chat reste désactivé)")) return;
    run(() => api(`/api/admin/demo-chat/journeys/${id}/publish`, "POST", { expectedUpdatedAt: token }), "Version publiée.").catch(() => {});
  };
  const addStep = async (payload) => { await run(() => api(`/api/admin/demo-chat/journeys/${id}/steps`, "POST", { expectedUpdatedAt: token, ...payload }), "Étape ajoutée."); setAdding(false); };
  const saveStep = async (stepId, payload) => { await run(() => api(`/api/admin/demo-chat/journeys/${id}/steps/${stepId}`, "PATCH", { expectedUpdatedAt: token, ...payload }), "Étape modifiée."); setEditing(null); };
  const deleteStep = (stepId) => { if (window.confirm("Supprimer cette étape du brouillon ?")) run(() => api(`/api/admin/demo-chat/journeys/${id}/steps/${stepId}`, "DELETE", { expectedUpdatedAt: token }), "Étape supprimée.").catch(() => {}); };

  if (!data) return <div className="p-6">{error ? <ErrorBox error={error} /> : <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />}</div>;
  const { journey, steps, versions, hasUnpublishedChanges } = data;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      <Link href="/admin/demo-chat" className="text-xs font-bold text-gray-500 hover:text-gray-900 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Parcours</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-black text-gray-900">{journey.name}</h1>
        <DemoBadge /> <SimulationBadge />
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{STATUS_LABEL[journey.status]}</span>
      </div>
      <ErrorBox error={error} />
      {notice && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{notice}</p>}

      <form onSubmit={saveHeader} className="p-4 rounded-2xl border border-gray-100 bg-white space-y-2">
        <input className={field} value={header.name} onChange={(e) => setHeader({ ...header, name: e.target.value })} disabled={readOnly} />
        <textarea className={field} rows={2} value={header.description} onChange={(e) => setHeader({ ...header, description: e.target.value })} disabled={readOnly} placeholder="Description" />
        <div className="flex flex-wrap gap-2">
          {!readOnly && <button disabled={busy} className="px-3 py-1.5 bg-gray-900 text-white text-xs font-bold rounded-lg flex items-center gap-1 disabled:opacity-50"><Save className="w-3.5 h-3.5" /> Enregistrer</button>}
          {journey.status === "draft"
            ? <button type="button" disabled={busy} onClick={() => archive("archive")} className="px-3 py-1.5 border border-gray-200 text-xs font-bold rounded-lg flex items-center gap-1"><Archive className="w-3.5 h-3.5" /> Archiver</button>
            : <button type="button" disabled={busy} onClick={() => archive("unarchive")} className="px-3 py-1.5 border border-gray-200 text-xs font-bold rounded-lg flex items-center gap-1"><ArchiveRestore className="w-3.5 h-3.5" /> Réactiver</button>}
          {versions.length === 0 && <button type="button" disabled={busy} onClick={remove} className="px-3 py-1.5 border border-red-200 text-red-700 text-xs font-bold rounded-lg flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Supprimer</button>}
          <Link href={`/admin/demo-chat/${id}/preview`} className="px-3 py-1.5 border border-gray-200 text-xs font-bold rounded-lg flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> Aperçu du brouillon</Link>
        </div>
      </form>

      <section className="p-4 rounded-2xl border border-gray-100 bg-white space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-gray-900">Étapes du brouillon ({steps.length})</h2>
          <div className="flex gap-2">
            {!readOnly && !adding && <button onClick={() => setAdding(true)} className="px-3 py-1.5 border border-gray-200 text-xs font-bold rounded-lg flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Ajouter</button>}
            {!readOnly && <button disabled={busy || !hasUnpublishedChanges} onClick={publish} className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-lg flex items-center gap-1 disabled:opacity-40"><Send className="w-3.5 h-3.5" /> Publier</button>}
          </div>
        </div>
        {!hasUnpublishedChanges && steps.length > 0 && <p className="text-[11px] text-gray-400">Aucun changement depuis la dernière version publiée.</p>}
        {adding && <StepForm initial={{}} onSubmit={addStep} onCancel={() => setAdding(false)} submitLabel="Ajouter l'étape" />}
        {byDay.length === 0 && !adding && <p className="text-sm text-gray-500">Aucune étape.</p>}
        {byDay.map(([day, list]) => (
          <div key={day} className="space-y-2">
            <p className="text-[11px] font-black text-gray-500 uppercase">Jour {day}</p>
            {list.map((s) => editing === s.id
              ? <StepForm key={s.id} initial={{ ...s, earningsPeriod: s.earningsPeriod || "yesterday", metric: s.metric || "commission" }} onSubmit={(p) => saveStep(s.id, p)} onCancel={() => setEditing(null)} submitLabel="Enregistrer" />
              : (
                <div key={s.id} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-gray-100">
                  <div className="min-w-0">
                    <p className="text-[11px] text-gray-500">{s.time} · {TYPE_LABEL[s.type]}{s.position ? ` · ordre ${s.position}` : ""}{s.type === "earnings" ? ` · ${PERIOD_LABEL[s.earningsPeriod]} · ${METRIC_LABEL[s.metric]}` : ""}</p>
                    <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{s.text}</p>
                  </div>
                  {!readOnly && (
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => setEditing(s.id)} className="p-1.5 text-gray-500 hover:text-gray-900" title="Modifier"><Pencil className="w-4 h-4" /></button>
                      <button onClick={() => deleteStep(s.id)} className="p-1.5 text-red-500 hover:text-red-700" title="Supprimer"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  )}
                </div>
              ))}
          </div>
        ))}
      </section>

      <section className="p-4 rounded-2xl border border-gray-100 bg-white space-y-2">
        <h2 className="text-sm font-bold text-gray-900">Versions publiées (figées)</h2>
        {versions.length === 0 && <p className="text-sm text-gray-500">Jamais publié.</p>}
        {versions.map((v) => (
          <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-xs border-b border-gray-50 py-2">
            <span><b>v{v.version}</b> · {v.stepCount} étape(s) · {fmtDate(v.publishedAt)} · <span className="font-mono text-gray-400">{v.stepsHash.slice(0, 12)}</span></span>
            <Link href={`/admin/demo-chat/${id}/preview?version=${v.id}`} className="font-bold text-indigo-700 flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> Aperçu</Link>
          </div>
        ))}
        <p className="text-[11px] text-gray-400">Une version publiée n'est ni modifiable ni supprimable. Elle n'est attribuée à aucun profil dans cette phase.</p>
      </section>
    </div>
  );
}
