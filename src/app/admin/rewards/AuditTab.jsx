"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { ErrorNote, api, fmtDate, btnGhost } from "./ui";

const ACTION_LABEL = {
  CONFIG_UPDATE: "Paramètres modifiés",
  GIFT_CREATE: "Cadeau créé", GIFT_UPDATE: "Cadeau modifié",
  GIFT_ACTIVATE: "Cadeau activé", GIFT_DEACTIVATE: "Cadeau désactivé",
  GIFT_ARCHIVE: "Cadeau archivé", GIFT_RESTORE: "Cadeau restauré",
  GIFT_STOCK_ADJUST: "Stock ajusté",
  REDEMPTION_FULFILLMENT_UPDATE: "Suivi / notes de demande",
};
const TYPES = [["", "Tout"], ["rewards_config", "Paramètres"], ["reward_gift", "Cadeaux"], ["reward_redemption", "Demandes"]];

/** Only the keys whose value changed, for a compact before → after line. */
function diff(before, after) {
  if (!before || !after) return [];
  return Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]) && k !== "updatedAt")
    .map((k) => `${k}: ${JSON.stringify(before[k] ?? null)} → ${JSON.stringify(after[k] ?? null)}`);
}

export default function AuditTab() {
  const [type, setType]     = useState("");
  const [rows, setRows]     = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  const load = useCallback(async (more = null) => {
    setLoading(true);
    const params = new URLSearchParams({ ...(type ? { entityType: type } : {}), ...(more ? { cursor: more } : {}) });
    const r = await api(`/api/admin/rewards/audit?${params}`);
    if (r.ok) { setRows((p) => (more ? [...p, ...r.data.items] : r.data.items)); setCursor(r.data.nextCursor); setError(null); }
    else setError(r.error);
    setLoading(false);
  }, [type]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex flex-wrap gap-2">
        {TYPES.map(([k, label]) => (
          <button key={k} onClick={() => setType(k)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${type === k ? "bg-gray-900 text-white border-gray-900" : "bg-gray-50 text-gray-600 border-gray-200"}`}>{label}</button>
        ))}
      </div>
      <p className="text-xs text-gray-500">Les mouvements de points (y compris les ajustements manuels) figurent dans le journal de chaque compte.</p>
      <ErrorNote message={error} />
      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-gray-400" /></div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 py-14 text-center text-gray-400 text-sm">Aucune entrée</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
          {rows.map((a) => (
            <div key={a.id} className="px-4 py-3 text-xs">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-semibold text-gray-900">{ACTION_LABEL[a.action] || a.action}</span>
                <span className="text-gray-400">{fmtDate(a.createdAt)} · {a.actorType}{a.actorId ? ` ${String(a.actorId).slice(0, 8)}` : ""}</span>
              </div>
              {a.reason && <p className="text-gray-600 mt-0.5">{a.reason}</p>}
              {diff(a.before, a.after).slice(0, 6).map((line) => <p key={line} className="text-gray-500 font-mono break-all">{line}</p>)}
            </div>
          ))}
          {cursor && <div className="p-3"><button onClick={() => load(cursor)} disabled={loading} className={`${btnGhost} w-full`}>Charger plus</button></div>}
        </div>
      )}
    </div>
  );
}
