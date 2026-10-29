"use client";

import { useEffect, useState } from "react";
import { Store, Loader2 } from "lucide-react";
import SettingsTab from "./SettingsTab";
import PackagesTab from "./PackagesTab";
import OptionsTab from "./OptionsTab";
import ProductsTab from "./ProductsTab";
import SimulationTab from "./SimulationTab";
import TermsTab from "./TermsTab";
import AccessesTab from "./AccessesTab";
import AuditTab from "./AuditTab";
import { api, btnPrimary } from "./ui";

// Config tabs edit ONE config object saved with one validated PUT; the other
// tabs load and save their own data.
const TABS = [
  { id: "accesses",   label: "Demandes",          Component: AccessesTab },
  { id: "settings",   label: "Paramètres",        Component: SettingsTab,   config: true },
  { id: "products",   label: "Catalogue produits", Component: ProductsTab,  config: true },
  { id: "packages",   label: "Packs",             Component: PackagesTab,   config: true },
  { id: "options",    label: "Options de marque", Component: OptionsTab,    config: true },
  { id: "simulation", label: "Simulation",        Component: SimulationTab, config: true },
  { id: "terms",      label: "Conditions",        Component: TermsTab },
  { id: "audit",      label: "Journal",           Component: AuditTab },
];

export default function AdminBrandPage() {
  const [tab, setTab] = useState("accesses");
  const [cfg, setCfgState] = useState(null);
  const [savedIds, setSavedIds] = useState(new Set());
  const [errors, setErrors] = useState({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const applySaved = (c) => {
    setCfgState(c);
    setSavedIds(new Set((c.packages || []).map((p) => p.id)));
    setErrors({});
    setDirty(false);
  };

  useEffect(() => {
    api("/api/admin/brand/config").then((r) => (r.ok ? applySaved(r.data) : setLoadError(r.error)));
  }, []);

  const setCfg = (fn) => { setCfgState(fn); setDirty(true); setNotice(null); };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    const r = await api("/api/admin/brand/config", { method: "PUT", body: cfg });
    setSaving(false);
    if (r.ok) {
      applySaved(r.data);
      setNotice({ ok: true, text: "Configuration enregistrée." });
    } else {
      setErrors(r.data?.errors || {});
      setNotice({ ok: false, text: r.data?.errors ? `${r.error} — corrigez les champs signalés.` : r.error });
    }
  };

  if (!cfg) {
    return (
      <div className="py-10 flex justify-center">
        {loadError ? <p className="text-sm text-red-600">{loadError}</p> : <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}
      </div>
    );
  }

  const current = TABS.find((t) => t.id === tab);
  const Active = current.Component;
  const errorTabs = {
    settings: !!errors.enabled,
    products: !!errors.catalogProductIds,
    packages: Object.keys(errors).some((k) => k.startsWith("packages")),
    options: Object.keys(errors).some((k) => k.startsWith("brandingOptions")),
    simulation: Object.keys(errors).some((k) => k.startsWith("simulation")),
  };

  return (
    <div className="py-6 max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Store className="w-6 h-6 text-violet-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">🏪 Create Your Own Brand</h1>
            <p className="text-sm text-gray-500">
              Simulateur de formation — offre {cfg.enabled ? "visible" : "masquée"}, simulation {cfg.simulation.enabled ? "activée" : "désactivée"}
              {cfg.updatedAt && ` · configuration modifiée le ${new Date(cfg.updatedAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}`}
            </p>
          </div>
        </div>
        {current.config && (
          <button type="button" onClick={save} disabled={saving || !dirty} className={btnPrimary}>
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Enregistrer
          </button>
        )}
      </div>

      {current.config && notice && (
        <p className={`text-sm rounded-xl px-3 py-2 border ${notice.ok ? "text-emerald-700 bg-emerald-50 border-emerald-100" : "text-red-600 bg-red-50 border-red-100"}`}>{notice.text}</p>
      )}
      {dirty && !notice && <p className="text-xs text-amber-700">Configuration modifiée — non enregistrée.</p>}

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`relative whitespace-nowrap px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${tab === t.id ? "bg-gray-900 text-white" : "bg-white border border-gray-200 text-gray-600 hover:border-gray-400"}`}>
            {t.label}
            {errorTabs[t.id] && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500" />}
          </button>
        ))}
      </div>

      {current.config ? <Active cfg={cfg} setCfg={setCfg} errors={errors} savedIds={savedIds} /> : <Active />}
    </div>
  );
}
