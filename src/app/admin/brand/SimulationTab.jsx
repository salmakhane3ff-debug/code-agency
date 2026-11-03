"use client";

import { AlertTriangle } from "lucide-react";
import { inputCls, Field, Check, FieldError } from "./ui";
import { SIM_OUTCOMES } from "@/lib/brandProgram";

const OUTCOME_LABEL = {
  delivered: "Livrées", refused: "Refusées", returned: "Retournées", noResponse: "Pas de réponse", cancelled: "Annulées",
};

/** Simulation settings (global). Everything stays empty until the admin fills it in. */
export default function SimulationTab({ cfg, setCfg, errors }) {
  const sim = cfg.simulation;
  const set = (patch) => setCfg((c) => ({ ...c, simulation: { ...c.simulation, ...patch } }));
  const setDist = (k, v) => set({ distribution: { ...sim.distribution, [k]: v } });
  const e = (k) => errors[`simulation.${k}`];
  const total = SIM_OUTCOMES.reduce((s, k) => s + (Number(sim.distribution?.[k]) || 0), 0);
  const num = (key, label, hint) => (
    <Field label={label} hint={hint} error={e(key)}>
      <input className={inputCls} type="number" min="0" step="1" value={sim[key] ?? ""} onChange={(ev) => set({ [key]: ev.target.value })} />
    </Field>
  );

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <Check label="Simulation activée" checked={sim.enabled} onChange={(x) => set({ enabled: x })} error={e("enabled")} />
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          Données de formation uniquement : aucune commande réelle, aucune commission, aucun point et aucun crédit de solde n’est jamais créé. Les périodes de pause ne sont jamais rattrapées.
        </p>
        {sim.activeSince && <p className="text-[11px] text-gray-400">Activée depuis le {new Date(sim.activeSince).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}</p>}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <p className="text-xs font-bold text-gray-700">Démarrage et volume</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {num("startDelayHours", "Délai avant démarrage (heures)", "Après l’activation de l’accès. Appliqué aux nouvelles activations.")}
          {num("dailyVolumeMin", "Commandes simulées par jour — minimum")}
          {num("dailyVolumeMax", "Commandes simulées par jour — maximum")}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <p className="text-xs font-bold text-gray-700">Vitesse de progression des statuts</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {num("confirmationDelayHours", "Délai avant confirmation (heures)", "Une commande reste « En attente » pendant ce délai.")}
          {num("deliveryDelayHours", "Délai avant statut final (heures)", "Les commandes confirmées deviennent livrées / refusées / retournées après ce délai.")}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <p className="text-xs font-bold text-gray-700">Répartition des statuts finaux (%)</p>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
          {SIM_OUTCOMES.map((k) => (
            <Field key={k} label={OUTCOME_LABEL[k]} error={errors[`simulation.distribution.${k}`]}>
              <input className={inputCls} type="number" min="0" max="100" step="1" value={sim.distribution?.[k] ?? ""} onChange={(ev) => setDist(k, ev.target.value)} />
            </Field>
          ))}
        </div>
        <p className={`text-xs font-semibold ${total === 100 ? "text-emerald-700" : "text-amber-700"}`}>Total : {total} %</p>
        <FieldError code={e("distribution")} />
      </div>
    </div>
  );
}
