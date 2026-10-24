"use client";

import { useState, useEffect } from "react";
import { Loader2, AlertTriangle, CheckCircle } from "lucide-react";
import { ErrorNote, api, fmtDate, inputCls, btnPrimary } from "./ui";

const NUMBERS = [
  ["pointsPerDeliveredOrder", "Points par commande livrée", "Attribués une seule fois, quand la commande passe à « Livrée »."],
  ["signupBonusPoints", "Points du bonus d'inscription", "Pour les nouveaux affiliés uniquement (créés après l'activation du bonus)."],
  ["orderPointsHoldDays", "Période de rétention (jours)", "Délai avant que les points d'une commande soient utilisables. 0 = immédiat."],
  ["maxOpenRedemptions", "Demandes en cours max. par affilié", "Nombre de demandes non terminées autorisées en même temps."],
  ["defaultLowStockThreshold", "Seuil de stock faible par défaut", "Utilisé quand un cadeau n'a pas de seuil propre."],
];

export default function SettingsTab() {
  const [cfg, setCfg]       = useState(null);
  const [form, setForm]     = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);
  const [done, setDone]     = useState(null);

  useEffect(() => {
    api("/api/admin/rewards/settings").then((r) => {
      if (r.ok) { setCfg(r.data); setForm(toForm(r.data)); } else setError(r.error);
    });
  }, []);

  if (!form) return error ? <ErrorNote message={error} /> : <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-gray-400" /></div>;

  const turningOn = !cfg.enabled && form.enabled;
  const save = async () => {
    if (turningOn && !confirm("Activer le programme de récompenses ?\n\nLes commandes déjà livrées ne rapporteront jamais de points. Les mises à jour de commandes sont suspendues quelques instants pendant l'activation.")) return;
    setSaving(true); setError(null); setDone(null);
    const body = { ...form };
    for (const [k] of NUMBERS) body[k] = form[k] === "" ? null : Number(form[k]);
    const r = await api("/api/admin/rewards/settings", { method: "PUT", body });
    setSaving(false);
    if (!r.ok) { setError(r.status === 503 ? `${r.error}` : r.error); return; }
    setCfg(r.data.config); setForm(toForm(r.data.config));
    setDone(turningOn ? `Programme activé — ${r.data.baselineExcluded} commande(s) déjà livrée(s) exclue(s).` : "Paramètres enregistrés.");
  };
  const toggle = (k) => setForm((f) => ({ ...f, [k]: !f[k] }));

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-5 max-w-2xl">
      <ErrorNote message={error} />
      {done && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2 flex gap-2"><CheckCircle className="w-4 h-4 shrink-0" /> {done}</p>}

      <Toggle label="Programme de récompenses actif" checked={form.enabled} onChange={() => toggle("enabled")}
        hint={cfg.launchedAt ? `Lancé le ${fmtDate(cfg.launchedAt)}${cfg.enabledAt && cfg.enabledAt !== cfg.launchedAt ? ` · réactivé le ${fmtDate(cfg.enabledAt)}` : ""}` : "Jamais activé"} />
      {turningOn && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> À l’activation, toutes les commandes déjà livrées sont exclues définitivement : seules les livraisons futures rapportent des points.
        </p>
      )}
      <Toggle label="Bonus d'inscription" checked={form.signupBonusEnabled} onChange={() => toggle("signupBonusEnabled")}
        hint={cfg.signupBonusEnabledAt ? `Actif depuis le ${fmtDate(cfg.signupBonusEnabledAt)} — les affiliés existants ne le reçoivent pas` : "Les affiliés existants ne le reçoivent pas"} />
      <Toggle label="Exclure les commandes suspectes" checked={form.excludeSuspicious} onChange={() => toggle("excludeSuspicious")}
        hint="Les commandes signalées comme suspectes ne rapportent pas de points." />

      <div className="grid sm:grid-cols-2 gap-4">
        {NUMBERS.map(([k, label, hint]) => (
          <label key={k} className="block">
            <span className="text-xs font-semibold text-gray-700">{label}</span>
            <input type="number" min={0} step={1} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} className={`${inputCls} mt-1`} />
            <span className="text-[11px] text-gray-400">{hint}</span>
          </label>
        ))}
      </div>

      <div className="flex justify-end">
        <button onClick={save} disabled={saving} className={btnPrimary}>{saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Enregistrer</button>
      </div>
    </div>
  );
}

function toForm(c) {
  return {
    enabled: c.enabled, signupBonusEnabled: c.signupBonusEnabled, excludeSuspicious: c.excludeSuspicious,
    ...Object.fromEntries(NUMBERS.map(([k]) => [k, String(c[k] ?? "")])),
  };
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-semibold text-gray-900">{label}</p>
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
      <button type="button" role="switch" aria-checked={checked} onClick={onChange}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${checked ? "bg-emerald-500" : "bg-gray-300"}`}>
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </div>
  );
}
