"use client";

/**
 * "Durée d'affichage des preuves de paiement" — the global display duration of the slider proofs
 * (GET / PUT /api/admin/payment-proofs/settings). 72 h by default, presets 7 / 30 days, or a custom
 * whole number of hours. It is captured on each proof at its ACTUAL publication: a change only
 * affects proofs published afterwards. Saves carry the loaded revision (conflict-safe).
 */

import { useState } from "react";
import { Loader2, Timer, RefreshCw } from "lucide-react";
import {
  DEFAULT_DISPLAY_HOURS, MIN_DISPLAY_HOURS, MAX_DISPLAY_HOURS, DISPLAY_DURATION_PRESETS,
  parseDisplayHours, describeDisplayHours, displayPresetOf,
} from "@/lib/paymentProofs";
import { inputCls, btnPrimary, btnGhost, api, apiErrorText, fmtInstant, API_ERROR_TEXT } from "./ui";

/** Title of a preset card: the default names itself, the others in days ("7 jours"). */
function presetTitle(hours) {
  if (hours === DEFAULT_DISPLAY_HOURS) return `${describeDisplayHours(hours)} — par défaut`;
  return hours % 24 === 0 ? `${hours / 24} jours` : describeDisplayHours(hours);
}

/** Why a typed custom duration is refused (French), or null when it is valid. */
function customProblem(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "Saisissez une durée en heures.";
  if (parseDisplayHours(v) !== null) return null;
  if (/^-/.test(v)) return "La durée ne peut pas être négative.";
  if (/[.,]/.test(v)) return "Nombre entier d'heures uniquement (pas de décimales).";
  if (/^\d+$/.test(v) && Number(v) < MIN_DISPLAY_HOURS) return `La durée doit être d'au moins ${MIN_DISPLAY_HOURS} heure.`;
  if (/^\d+$/.test(v) && Number(v) > MAX_DISPLAY_HOURS) return `${MAX_DISPLAY_HOURS} heures (365 jours) maximum.`;
  return `Durée invalide : nombre entier d'heures entre ${MIN_DISPLAY_HOURS} et ${MAX_DISPLAY_HOURS}.`;
}

const formOf = (settings) => {
  const preset = displayPresetOf(settings?.hours);
  return { choice: preset, custom: preset === "custom" ? String(settings?.hours ?? "") : "" };
};

export default function DisplaySettings({ settings, loading, error, onReload, onSaved }) {
  if (!settings) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-2">
        <h2 className="text-sm font-bold text-gray-900 inline-flex items-center gap-1.5"><Timer className="w-4 h-4 text-violet-600" />Durée d&apos;affichage des preuves de paiement</h2>
        {loading && <p className="text-xs text-gray-500 inline-flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" />Chargement…</p>}
        {error && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-xs text-red-600 break-words">{error}</p>
            <button type="button" className={btnGhost} onClick={onReload}><RefreshCw className="w-3.5 h-3.5" />Réessayer</button>
          </div>
        )}
      </div>
    );
  }
  // Mounted once the settings are loaded: the form starts from them (no effect needed).
  return <SettingsForm settings={settings} onSaved={onSaved} />;
}

function SettingsForm({ settings, onSaved }) {
  const [form, setForm] = useState(() => formOf(settings));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: 'ok' | 'error', text }
  const presets = DISPLAY_DURATION_PRESETS;

  const problem = form.choice === "custom" ? customProblem(form.custom) : null;
  const hours = form.choice === "custom" ? parseDisplayHours(String(form.custom).trim()) : presets.find((p) => p.key === form.choice)?.hours ?? null;
  const unchanged = hours !== null && hours === settings.hours;
  const canSave = !busy && hours !== null && !problem && !unchanged;

  const pick = (choice) => { setForm((f) => ({ ...f, choice })); setMsg(null); };

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setMsg(null);
    const res = await api("/api/admin/payment-proofs/settings", { method: "PUT", body: { hours, revision: settings.revision } });
    setBusy(false);
    if (res.ok) {
      onSaved(res.data);
      setForm(formOf(res.data));
      setMsg({ kind: "ok", text: `Enregistré : les preuves publiées à partir de maintenant seront visibles ${res.data.label}.` });
      return;
    }
    if (res.data?.code === "SETTINGS_CONFLICT" && res.data.current) {
      // Someone else saved first: show the current values (nothing was written).
      onSaved(res.data.current);
      setForm(formOf(res.data.current));
      setMsg({ kind: "error", text: `${API_ERROR_TEXT.SETTINGS_CONFLICT} Valeur actuelle : ${res.data.current.label}.` });
      return;
    }
    setMsg({ kind: "error", text: apiErrorText(res) });
  };

  const radioCls = (on) => `flex items-start gap-2 rounded-xl border p-3 cursor-pointer min-w-0 ${on ? "border-gray-900 bg-gray-50" : "border-gray-200 bg-white hover:bg-gray-50"}`;
  const history = Array.isArray(settings.history) ? settings.history : [];

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3 min-w-0" data-display-settings>
      <div className="space-y-1">
        <h2 className="text-sm font-bold text-gray-900 inline-flex items-center gap-1.5"><Timer className="w-4 h-4 text-violet-600" />Durée d&apos;affichage des preuves de paiement</h2>
        <p className="text-xs text-gray-700 break-words">
          Actuellement : <strong data-display-current>{settings.label}</strong>{settings.isDefault ? " (par défaut)" : ""}
        </p>
        <p className="text-[11px] text-gray-500 break-words">
          {settings.updatedAt
            ? <>Dernière modification : {fmtInstant(settings.updatedAt)} (heure du Maroc) par {settings.updatedByName || "Administrateur"}</>
            : <>Jamais modifiée : la valeur par défaut s&apos;applique.</>}
        </p>
      </div>

      <fieldset className="space-y-2 min-w-0">
        <legend className="sr-only">Durée d&apos;affichage</legend>
        <div className="grid sm:grid-cols-2 gap-2">
          {presets.map((p) => (
            <label key={p.key} className={radioCls(form.choice === p.key)}>
              <input type="radio" name="proof-display-duration" value={p.key} checked={form.choice === p.key} onChange={() => pick(p.key)} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-gray-900">{presetTitle(p.hours)}</span>
                {p.hours !== DEFAULT_DISPLAY_HOURS && <span className="block text-[11px] text-gray-500">{p.hours} heures</span>}
              </span>
            </label>
          ))}
          <label className={radioCls(form.choice === "custom")}>
            <input type="radio" name="proof-display-duration" value="custom" checked={form.choice === "custom"} onChange={() => pick("custom")} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-xs font-semibold text-gray-900">Durée personnalisée (en heures)</span>
              <input type="number" inputMode="numeric" min={MIN_DISPLAY_HOURS} max={MAX_DISPLAY_HOURS} step={1} className={inputCls}
                aria-label="Durée personnalisée en heures" placeholder={`${MIN_DISPLAY_HOURS} à ${MAX_DISPLAY_HOURS}`}
                value={form.custom} aria-invalid={form.choice === "custom" && !!problem}
                onFocus={() => { if (form.choice !== "custom") pick("custom"); }}
                onChange={(e) => { setForm({ choice: "custom", custom: e.target.value }); setMsg(null); }} />
              {form.choice === "custom" && (problem
                ? <span className="block text-[11px] text-red-600" data-display-error>{problem}</span>
                : <span className="block text-[11px] text-gray-600" data-display-preview>= {describeDisplayHours(hours)}</span>)}
            </span>
          </label>
        </div>
      </fieldset>

      <p className="text-[11px] text-gray-500 break-words">
        S&apos;applique aux preuves publiées à partir de maintenant. Les preuves déjà publiées gardent la durée qu&apos;elles avaient à leur
        publication. Une preuve programmée prend la durée en vigueur au moment de sa publication.
      </p>

      {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={`text-xs break-words ${msg.kind === "error" ? "text-red-600" : "text-emerald-700"}`}>{msg.text}</p>}

      <div className="flex flex-wrap items-center gap-2 justify-end">
        {hours !== null && !problem && !unchanged && (
          <span className="text-[11px] text-gray-600 mr-auto">Nouvelle durée : {describeDisplayHours(hours)}</span>
        )}
        <button type="button" className={btnPrimary} onClick={save} disabled={!canSave} data-display-save>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Enregistrer
        </button>
      </div>

      {history.length > 0 && (
        <details className="text-[11px] text-gray-600">
          <summary className="cursor-pointer font-semibold text-gray-700">Historique des modifications ({history.length})</summary>
          <ol className="mt-2 space-y-1">
            {history.map((h, i) => (
              <li key={`${h.at}-${i}`} className="rounded-lg border border-gray-100 bg-gray-50 px-2.5 py-1.5 break-words">
                {fmtInstant(h.at)} · {h.byName || "Administrateur"} : {describeDisplayHours(h.fromHours) || "—"} → {describeDisplayHours(h.toHours) || "—"}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
