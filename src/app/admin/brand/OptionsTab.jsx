"use client";

import { Plus } from "lucide-react";
import { inputCls, btnGhost, Field, Check, FieldError, newId } from "./ui";

/** Branding / customization options the affiliate can choose from (labels only — no price). */
export default function OptionsTab({ cfg, setCfg, errors }) {
  const options = cfg.brandingOptions;
  const setOptions = (next) => setCfg((c) => ({ ...c, brandingOptions: next }));
  const update = (i, patch) => setOptions(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">Ex. styles de logo, types d’emballage, étiquettes. Affichées sur la page de l’affilié quand elles sont actives.</p>
        <button type="button" onClick={() => setOptions([...options, { id: newId("opt"), label: "", description: "", active: false }])} className={btnGhost}>
          <Plus className="w-3.5 h-3.5" />Nouvelle option
        </button>
      </div>
      <FieldError code={errors.brandingOptions} />
      {options.length === 0 && <p className="text-sm text-gray-500 bg-white rounded-2xl border border-gray-100 p-6 text-center">Aucune option configurée.</p>}
      {options.map((o, i) => (
        <div key={o.id || i} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
          <FieldError code={errors[`brandingOptions.${i}.id`]} />
          <Field label="Libellé" error={errors[`brandingOptions.${i}.label`]}>
            <input className={inputCls} value={o.label ?? ""} onChange={(e) => update(i, { label: e.target.value })} />
          </Field>
          <Field label="Description">
            <textarea className={inputCls} rows={2} value={o.description ?? ""} onChange={(e) => update(i, { description: e.target.value })} />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <Check label="Option active" checked={o.active} onChange={(x) => update(i, { active: x })} />
            <button type="button" onClick={() => setOptions(options.filter((_, j) => j !== i))} className={btnGhost}>Retirer</button>
          </div>
        </div>
      ))}
    </div>
  );
}
