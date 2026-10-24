"use client";

/**
 * /admin/demo-chat/audit — append-only audit trail of demo-chat authoring
 * (Phase 3C-2). Read-only: entries can never be edited or deleted.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ArrowLeft } from "lucide-react";
import { api, field, DemoBadge, ErrorBox, fmtDate } from "../ui";

export default function DemoChatAuditPage() {
  const [entries, setEntries] = useState([]);
  const [next, setNext] = useState(null);
  const [entityType, setEntityType] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async (before) => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: "50" });
      if (entityType) q.set("entityType", entityType);
      if (before) q.set("before", before);
      const d = await api(`/api/admin/demo-chat/audit?${q}`);
      setEntries((cur) => (before ? [...cur, ...d.entries] : d.entries)); setNext(d.nextBefore); setError(null);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [entityType]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
      <Link href="/admin/demo-chat" className="text-xs font-bold text-gray-500 hover:text-gray-900 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Parcours</Link>
      <h1 className="text-lg font-black text-gray-900 flex items-center gap-2">Journal d'audit — chat démo <DemoBadge /></h1>
      <p className="text-xs text-gray-500">Lecture seule : les entrées ne peuvent être ni modifiées ni supprimées.</p>
      <select className={`${field} max-w-xs`} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
        <option value="">Tous les éléments</option><option value="journey">Parcours</option><option value="step">Étapes</option><option value="version">Versions</option><option value="asset">Médias</option><option value="assignment">Attributions</option><option value="config">Interrupteur global</option>
      </select>
      <ErrorBox error={error} />
      <div className="rounded-2xl border border-gray-100 bg-white divide-y divide-gray-50">
        {entries.length === 0 && !loading && <p className="p-6 text-sm text-gray-500 text-center">Aucune entrée.</p>}
        {entries.map((e) => (
          <details key={e.id} className="p-3 text-xs">
            <summary className="cursor-pointer"><b>{e.action}</b> · {e.entityType} <span className="font-mono text-gray-400">{e.entityId}</span> · {e.actorType} {e.actorId || ""} · {fmtDate(e.createdAt)}</summary>
            <pre className="mt-2 p-2 bg-gray-50 rounded-lg overflow-x-auto text-[11px]">{JSON.stringify({ before: e.before, after: e.after, reason: e.reason }, null, 2)}</pre>
          </details>
        ))}
      </div>
      {loading && <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />}
      {next && !loading && <button onClick={() => load(next)} className="px-3 py-1.5 border border-gray-200 text-xs font-bold rounded-lg">Plus ancien</button>}
    </div>
  );
}
