"use client";

/**
 * /admin/demo-chat — scripted DEMO chat journeys (Phase 3C-2, authoring only).
 * Simulation: no AI, no WhatsApp/SMS, never real affiliates, orders or money.
 * Assignments and the global switch live on /admin/demo-chat/assignments (Phase 3C-9B);
 * the chat stays disabled unless both gates are on.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, ChevronRight, ShieldOff, History, Images, Users } from "lucide-react";
import { validateJourneyInput } from "@/lib/demoChatValidation";
import { api, field, DemoBadge, SimulationBadge, ErrorBox, STATUS_LABEL, fmtDate } from "./ui";

function GateBanner({ status }) {
  if (!status) return null;
  return (
    <div className="flex items-start gap-3 p-4 rounded-2xl border border-amber-200 bg-amber-50 text-amber-900 text-xs">
      <ShieldOff className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="space-y-1">
        <p className="font-bold">{status.enabled ? `Mini Chat activé — ${status.enabledAssignments ?? 0} conversation(s) activée(s)` : "Chat démo désactivé"}</p>
        <p>Variable serveur DEMO_CHAT_ENABLED : <b>{status.env ? "true" : "false"}</b> · Paramètre protégé « demo-chat-config » : <b>{status.setting ? "activé" : "désactivé"}</b>. Les deux sont requis.</p>
        <p>{status.note}</p>
      </div>
    </div>
  );
}

export default function DemoChatPage() {
  const [list, setList] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [j, s] = await Promise.all([api("/api/admin/demo-chat/journeys"), api("/api/admin/demo-chat/status")]);
      setList(j.journeys); setStatus(s); setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    const v = validateJourneyInput(form);
    if (!v.ok) { setError(v.error); return; }
    setBusy(true);
    try { await api("/api/admin/demo-chat/journeys", "POST", form); setForm({ name: "", description: "" }); await load(); }
    catch (e2) { setError(e2.message); } finally { setBusy(false); }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-black text-gray-900 flex items-center gap-2">💬 Chat démo — parcours <DemoBadge /> <SimulationBadge /></h1>
        <div className="flex items-center gap-4">
          <Link href="/admin/demo-chat/assignments" className="text-xs font-bold text-gray-600 hover:text-gray-900 flex items-center gap-1"><Users className="w-4 h-4" /> Attributions</Link>
          <Link href="/admin/demo-chat/assets" className="text-xs font-bold text-gray-600 hover:text-gray-900 flex items-center gap-1"><Images className="w-4 h-4" /> Médias</Link>
          <Link href="/admin/demo-chat/audit" className="text-xs font-bold text-gray-600 hover:text-gray-900 flex items-center gap-1"><History className="w-4 h-4" /> Journal d'audit</Link>
        </div>
      </div>
      <GateBanner status={status} />
      <ErrorBox error={error} />

      <form onSubmit={create} className="p-4 rounded-2xl border border-gray-100 bg-white space-y-2">
        <h2 className="text-sm font-bold text-gray-900">Nouveau parcours (brouillon)</h2>
        <input className={field} placeholder="Nom du parcours" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <textarea className={field} rows={2} placeholder="Description (optionnel)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <button disabled={busy} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl disabled:opacity-50 flex items-center gap-2">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Créer
        </button>
      </form>

      <div className="rounded-2xl border border-gray-100 bg-white divide-y divide-gray-50">
        {!list && !error && <div className="p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>}
        {list && list.length === 0 && <p className="p-6 text-sm text-gray-500 text-center">Aucun parcours.</p>}
        {list?.map((j) => (
          <Link key={j.id} href={`/admin/demo-chat/${j.id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50">
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">{j.name}</p>
              <p className="text-[11px] text-gray-500">
                {STATUS_LABEL[j.status] || j.status} · {j.stepCount} étape(s) · {j.latestVersion ? `v${j.latestVersion.version} publiée le ${fmtDate(j.latestVersion.publishedAt)}` : "jamais publié"} · modifié {fmtDate(j.updatedAt)}
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
