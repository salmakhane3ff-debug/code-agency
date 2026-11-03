"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "./ui";

const ACTION_LABEL = {
  CONFIG_UPDATE: "Configuration modifiée",
  TERMS_DRAFT_UPDATE: "Brouillon des conditions modifié",
  TERMS_PUBLISHED: "Conditions approuvées et publiées",
  ACCESS_REQUESTED: "Demande d’accès",
  ACCESS_CANCELLED: "Demande annulée par l’affilié",
  ACCESS_ACTIVATED: "Accès activé (paiement vérifié)",
  ACCESS_REJECTED: "Demande refusée",
};
const fmt = (d) => new Date(d).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

/** Append-only audit trail (read-only). */
export default function AuditTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api("/api/admin/brand/audit").then((r) => (r.ok ? setRows(r.data) : setError(r.error))); }, []);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!rows) return <Loader2 className="w-6 h-6 animate-spin text-gray-400" />;
  if (!rows.length) return <p className="text-sm text-gray-500 bg-white rounded-2xl border border-gray-100 p-6 text-center">Aucune entrée.</p>;
  return (
    <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
      {rows.map((r) => (
        <div key={r.id} className="px-4 py-3 text-sm flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-gray-800">{ACTION_LABEL[r.action] || r.action}</p>
            <p className="text-xs text-gray-500">{r.actorType}{r.actorId ? ` · ${r.actorId}` : ""}{r.entityId ? ` · ${r.entityType} ${r.entityId}` : ""}</p>
            {r.reason && <p className="text-xs text-gray-500">{r.reason}</p>}
          </div>
          <span className="text-xs text-gray-400 whitespace-nowrap">{fmt(r.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}
