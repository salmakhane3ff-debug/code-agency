"use client";

import { AlertTriangle } from "lucide-react";
import { Check } from "./ui";

export default function SettingsTab({ cfg, setCfg, errors }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-4">
      <Check label="Offre « Create Your Own Brand » visible par les affiliés (demandes d’accès possibles)" checked={cfg.enabled}
        onChange={(x) => setCfg((c) => ({ ...c, enabled: x }))} error={errors.enabled} />
      <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-2 space-y-1">
        <p className="flex items-start gap-1.5 font-semibold"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />À savoir avant d’activer l’offre</p>
        <p>• Produit de formation : les affiliés achètent un accès au simulateur. Les commandes affichées sont simulées et ne génèrent aucun gain.</p>
        <p>• L’étape de paiement en ligne n’est pas encore branchée : une demande reste « en attente de paiement » jusqu’à ce qu’un administrateur vérifie le paiement et active l’accès (onglet Demandes).</p>
        <p>• Aucun achat n’est possible tant que des conditions de remboursement n’ont pas été approuvées et publiées (onglet Conditions).</p>
      </div>
    </div>
  );
}
