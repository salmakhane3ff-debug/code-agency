"use client";

/**
 * /admin/demo-chat/:id/preview[?version=<id>] — 30-day timeline of a draft or a
 * published version (Phase 3C-2). Writes nothing. Earnings messages show
 * labelled SAMPLE values — never real or demo figures.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Loader2, ArrowLeft, Info } from "lucide-react";
import { api, DemoBadge, SimulationBadge, ErrorBox, TYPE_LABEL, AssetThumb } from "../../ui";

export default function DemoChatPreviewPage() {
  const { id } = useParams();
  const versionId = useSearchParams().get("version") || undefined;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [onlyFilled, setOnlyFilled] = useState(true);

  useEffect(() => {
    api("/api/admin/demo-chat/preview", "POST", { journeyId: id, versionId }).then(setData, (e) => setError(e.message));
  }, [id, versionId]);

  if (!data) return <div className="p-6">{error ? <ErrorBox error={error} /> : <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />}</div>;
  const days = onlyFilled ? data.days.filter((d) => d.messages.length) : data.days;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
      <Link href={`/admin/demo-chat/${id}`} className="text-xs font-bold text-gray-500 hover:text-gray-900 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Retour au parcours</Link>
      <h1 className="text-lg font-black text-gray-900 flex flex-wrap items-center gap-2">
        Aperçu {data.source.kind === "version" ? `— version ${data.source.version}` : "— brouillon"} <DemoBadge /> <SimulationBadge />
      </h1>
      <div className="flex items-start gap-2 p-3 rounded-xl bg-indigo-50 border border-indigo-100 text-xs text-indigo-900">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <p>{data.disclosure} Heures affichées : fuseau {data.timezone}. Exemples utilisés : {"{amount}"} = {data.sampleValues.amount}, {"{orders}"} = {data.sampleValues.orders}.</p>
      </div>
      <label className="text-xs text-gray-600 flex items-center gap-2"><input type="checkbox" checked={onlyFilled} onChange={(e) => setOnlyFilled(e.target.checked)} /> Masquer les jours sans message</label>
      {days.map((d) => (
        <div key={d.day} className="space-y-2">
          <p className="text-[11px] font-black text-gray-500 uppercase">Jour {d.day}</p>
          {d.messages.length === 0 && <p className="text-xs text-gray-400">—</p>}
          {d.messages.map((m) => (
            <div key={m.id} className="max-w-md p-3 rounded-2xl rounded-tl-sm bg-white border border-gray-100 shadow-sm">
              {m.asset && <div className="mb-1"><AssetThumb asset={m.asset} /></div>}
              {m.text && <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{m.text}</p>}
              <p className="mt-1 text-[10px] text-gray-400">{m.time} · {TYPE_LABEL[m.type]}{m.usesSampleValues ? " · valeurs d'exemple" : ""}</p>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
