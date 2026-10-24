"use client";

import { useState } from "react";
import { Gift } from "lucide-react";
import GiftsTab from "./GiftsTab";
import RedemptionsTab from "./RedemptionsTab";
import AccountsTab from "./AccountsTab";
import SettingsTab from "./SettingsTab";
import AuditTab from "./AuditTab";

const TABS = [
  { id: "gifts",       label: "Catalogue",  Component: GiftsTab },
  { id: "redemptions", label: "Demandes",   Component: RedemptionsTab },
  { id: "accounts",    label: "Comptes",    Component: AccountsTab },
  { id: "settings",    label: "Paramètres", Component: SettingsTab },
  { id: "audit",       label: "Journal",    Component: AuditTab },
];

export default function AdminRewardsPage() {
  const [tab, setTab] = useState("gifts");
  const Active = TABS.find((t) => t.id === tab).Component;
  return (
    <div className="py-6 max-w-6xl space-y-5">
      <div className="flex items-center gap-3">
        <Gift className="w-6 h-6 text-violet-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🎁 Récompenses affiliés</h1>
          <p className="text-sm text-gray-500">Points, catalogue de cadeaux et demandes de livraison</p>
        </div>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`whitespace-nowrap px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${tab === t.id ? "bg-gray-900 text-white" : "bg-white border border-gray-200 text-gray-600 hover:border-gray-400"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <Active />
    </div>
  );
}
