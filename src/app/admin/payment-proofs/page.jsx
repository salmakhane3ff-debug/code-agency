"use client";

import { useState } from "react";
import { Receipt } from "lucide-react";
import ScheduleBuilder from "./ScheduleBuilder";
import ProofsList from "./ProofsList";

const TABS = [
  { id: "list", label: "Preuves" },
  { id: "schedule", label: "Programmer un lot" },
];

/**
 * Admin — Payment Proofs: an independent, admin-managed DISPLAY feed for the single
 * slider of the affiliate dashboard (manual count per day, manual time per proof),
 * and its management (edit / cancel before publication, audit history).
 */
export default function AdminPaymentProofsPage() {
  const [tab, setTab] = useState("list");
  const [listKey, setListKey] = useState(0);
  // The builder stays mounted while hidden so an in-progress batch is never lost.
  return (
    <div className="py-6 max-w-5xl space-y-5 [contain:inline-size]">
      <div className="flex items-start gap-3 min-w-0">
        <Receipt className="w-6 h-6 text-violet-600 shrink-0 mt-1" />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">🧾 Preuves de paiement</h1>
          <p className="text-sm text-gray-500 break-words">
            Reçus affichés dans le slider du tableau de bord affilié — le même pour tous les affiliés actifs. Chaque preuve
            est visible pendant 72 h à partir de sa publication effective, puis disparaît du slider (elle reste ici).
            Le nom et le montant sont des données d&apos;affichage, sans lien avec un compte ou un paiement.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 pb-1" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`whitespace-nowrap px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${tab === t.id ? "bg-gray-900 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div hidden={tab !== "list"}>
        <ProofsList key={listKey} />
      </div>
      <div hidden={tab !== "schedule"}>
        <ScheduleBuilder onShowList={() => { setListKey((k) => k + 1); setTab("list"); }} />
      </div>
    </div>
  );
}
