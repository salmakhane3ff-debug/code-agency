"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { ChevronDown, Gauge, Loader2 } from "lucide-react";
import { api, inputCls, btnPrimary, btnGhost, errText, FieldError } from "./ui";

/**
 * Per-brand simulation speed (one brand access). Backend: src/lib/brandSimSpeed.js,
 * GET/PUT /api/admin/brand/accesses/{id}/simulation-speed. A change takes effect at the
 * next full hour; SIMULATED orders only (no wallet, commission or real order).
 */

const TZ = "Africa/Casablanca";
const HOUR_FMT = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
const DAY_KEY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const DAY_FMT = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "numeric", month: "short" });
const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });

/** Same bounds as validateSpeedInput (src/lib/brandSimSpeed.js). */
const MAX_PER_HOUR = 300;
const MAX_PER_DAY = 1000;
const FIELDS = [
  { key: "hourMin", label: "Commandes min / heure", max: MAX_PER_HOUR, minAllowed: 0, attr: "data-speed-hour-min" },
  { key: "hourMax", label: "Commandes max / heure", max: MAX_PER_HOUR, minAllowed: 1, attr: "data-speed-hour-max" },
  { key: "dayMin",  label: "Commandes min / 24 h",  max: MAX_PER_DAY,  minAllowed: 0, attr: "data-speed-day-min" },
  { key: "dayMax",  label: "Commandes max / 24 h",  max: MAX_PER_DAY,  minAllowed: 1, attr: "data-speed-day-max" },
];

const valid = (d) => d && !Number.isNaN(new Date(d).getTime());
/** "HH:00" in Morocco time (+ the day when it is not today there). */
function fromHour(iso) {
  if (!valid(iso)) return "—";
  const d = new Date(iso);
  const hh = (HOUR_FMT.formatToParts(d).find((p) => p.type === "hour")?.value || "00").padStart(2, "0");
  const sameDay = DAY_KEY_FMT.format(d) === DAY_KEY_FMT.format(new Date());
  return sameDay ? `${hh}:00` : `${hh}:00 (le ${DAY_FMT.format(d)})`;
}
const fmtDate = (iso) => (valid(iso) ? DATE_FMT.format(new Date(iso)) : "—");

/** Short description of a version (or of the global behaviour when null). */
function describe(v, global) {
  if (v && v.enabled === false) return { kind: "paused", text: "En pause (cette marque)" };
  if (v?.limits) {
    const l = v.limits;
    return { kind: "custom", text: `Personnalisée : ${l.hourMin}–${l.hourMax} / h · ${l.dayMin}–${l.dayMax} / 24 h` };
  }
  const range = global && global.dailyVolumeMin != null && global.dailyVolumeMax != null
    ? ` (${global.dailyVolumeMin}–${global.dailyVolumeMax} commandes / jour)` : "";
  const off = global && !global.enabled ? " — simulation globale désactivée" : "";
  return { kind: "global", text: `Réglages globaux${range}${off}` };
}
const CHIP_CLS = {
  global: "bg-gray-50 text-gray-700 border-gray-200",
  custom: "bg-sky-50 text-sky-700 border-sky-200",
  paused: "bg-amber-50 text-amber-700 border-amber-200",
};

/** Form values from pending ?? current ?? defaults (custom fields empty). */
function formFrom(data) {
  const v = data?.pending ?? data?.current ?? null;
  const l = v?.limits;
  return {
    enabled: v ? v.enabled !== false : true,
    custom: !!l,
    hourMin: l ? String(l.hourMin) : "",
    hourMax: l ? String(l.hourMax) : "",
    dayMin: l ? String(l.dayMin) : "",
    dayMax: l ? String(l.dayMax) : "",
  };
}

const toInt = (s) => (/^\d+$/.test(String(s ?? "").trim()) ? Number(String(s).trim()) : NaN);

/**
 * Client-side mirror of validateSpeedInput (the server stays the authority).
 * → { errors: { field|'limits': CODE }, missing, effective: {min,max}|null, gap: {min,max,need}|null (DAY_RANGE_TOO_NARROW) }
 */
function checkForm(f) {
  if (!f.custom) return { errors: {}, missing: false, effective: null };
  const errors = {};
  const v = {};
  let missing = false;
  for (const { key, max, minAllowed } of FIELDS) {
    if (String(f[key] ?? "").trim() === "") { missing = true; continue; }
    const n = toInt(f[key]);
    if (Number.isNaN(n) || n < minAllowed || n > max) errors[key] = "INVALID_NUMBER";
    else v[key] = n;
  }
  const has = (k) => v[k] !== undefined;
  if (has("hourMin") && has("hourMax") && v.hourMin > v.hourMax) errors.hourMin = "HOUR_RANGE";
  if (has("dayMin") && has("dayMax") && v.dayMin > v.dayMax) errors.dayMin = "DAY_RANGE";
  const complete = !missing && !Object.keys(errors).length;
  let gap = null;
  if (complete) {
    if (24 * v.hourMin > v.dayMax) errors.limits = "HOUR_MIN_OVER_DAY_MAX";
    else if (24 * v.hourMax < v.dayMin) errors.limits = "HOUR_MAX_UNDER_DAY_MIN";
    else {
      // requiredDayGap: the maximum must hold over every sliding 24-hour period (up to 25 clock hours).
      const eMin = Math.max(v.dayMin, 24 * v.hourMin), eMax = Math.min(v.dayMax, 24 * v.hourMax);
      const need = Math.min(v.hourMax, Math.ceil(eMin / 24));
      if (eMax - eMin < need) { errors.limits = "DAY_RANGE_TOO_NARROW"; gap = { min: eMin, max: eMax, need }; }
    }
  }
  const effective = complete && !errors.limits
    ? { min: Math.max(v.dayMin, 24 * v.hourMin), max: Math.min(v.dayMax, 24 * v.hourMax) }
    : null;
  return { errors, missing, effective, gap };
}

export default function SpeedPanel({ accessId, status }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(formFrom(null));
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [topError, setTopError] = useState(null);
  const [success, setSuccess] = useState(null);

  const url = `/api/admin/brand/accesses/${encodeURIComponent(accessId)}/simulation-speed`;
  const load = useCallback(async () => {
    const r = await api(url);
    if (r.ok) { setData(r.data); setForm(formFrom(r.data)); setLoadError(null); } else setLoadError(r.error);
  }, [url]);
  useEffect(() => { load(); }, [load, status]);

  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setServerErrors({}); setTopError(null); setSuccess(null); };
  const { errors: clientErrors, missing, effective, gap } = checkForm(form);
  const invalid = form.custom && (missing || Object.keys(clientErrors).length > 0);
  const editable = !!data?.editable;
  const fieldError = (k) => serverErrors[k] || clientErrors[k];
  const limitsError = serverErrors.limits || clientErrors.limits;

  const save = async () => {
    if (!editable || invalid || saving) return;
    setSaving(true); setServerErrors({}); setTopError(null); setSuccess(null);
    const body = form.custom
      ? { enabled: form.enabled, custom: true, hourMin: toInt(form.hourMin), hourMax: toInt(form.hourMax), dayMin: toInt(form.dayMin), dayMax: toInt(form.dayMax) }
      : { enabled: form.enabled, custom: false };
    const r = await api(url, { method: "PUT", body });
    setSaving(false);
    if (r.ok) {
      setData(r.data);
      setForm(formFrom(r.data));
      setSuccess(`Enregistré — appliqué à partir de ${fromHour(r.data?.pending?.effectiveFrom)}`);
      return;
    }
    const errs = r.data?.errors && typeof r.data.errors === "object" ? r.data.errors : null;
    if (errs && Object.keys(errs).length) {
      setServerErrors(errs);
      const unplaced = Object.keys(errs).filter((k) => k !== "limits" && k !== "enabled" && !FIELDS.some((f) => f.key === k));
      setTopError(unplaced.length ? `${r.error} (${unplaced.map((k) => `${k} : ${errText(errs[k])}`).join(" ; ")})` : (errs.limits ? null : r.error));
    } else {
      setTopError(r.data?.code === "ACCESS_NOT_EDITABLE" ? errText("ACCESS_NOT_EDITABLE") : r.error);
      if (r.data?.code === "ACCESS_NOT_EDITABLE") load();
    }
  };

  const state = data ? describe(data.current, data.global) : null;
  const bodyId = `${uid}-body`;
  const history = data?.history ? [...data.history].reverse() : [];
  const nowMs = Date.now();

  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-2" data-speed-panel={accessId}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={bodyId}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700 hover:text-gray-900">
          <Gauge className="w-3.5 h-3.5" />
          Vitesse de simulation
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {state && (
          <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${CHIP_CLS[state.kind]}`} data-speed-state={state.kind}>
            {state.text}
          </span>
        )}
        {data?.pending && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-violet-50 text-violet-700 border-violet-200" data-speed-pending>
            {data.pending.enabled === false ? "En pause" : "Nouvelle configuration"} à partir de {fromHour(data.pending.effectiveFrom)}
          </span>
        )}
        {!data && !loadError && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" aria-label="Chargement" />}
      </div>
      {loadError && <p className="text-xs text-red-600">{loadError}</p>}

      {open && data && (
        <div id={bodyId} className="space-y-3">
          {data.pending && (
            <p className="text-[11px] text-gray-600">À venir : {describe(data.pending, data.global).text} — à partir de {fromHour(data.pending.effectiveFrom)}.</p>
          )}
          <p className="text-[11px] text-gray-500 leading-relaxed">
            Les changements s’appliquent à partir de la prochaine heure pleine (heure du Maroc) ; les heures déjà simulées ne sont jamais modifiées.
            Les limites par heure et sur 24 h glissantes sont toutes respectées (le maximum sur 24 h n’est jamais dépassé).
            Commandes simulées uniquement : aucun solde, aucune commission, aucune commande réelle.
          </p>
          {!editable && (
            <p className="text-[11px] text-gray-600" data-speed-readonly>
              Lecture seule : la vitesse ne se règle que pour une marque demandée ou active.
            </p>
          )}

          <form onSubmit={(ev) => { ev.preventDefault(); save(); }} noValidate>
            <fieldset disabled={!editable || saving} className="space-y-3 min-w-0">
              <legend className="sr-only">Vitesse de simulation de cette marque</legend>
              <div>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-speed-enabled />
                  Simulation active pour cette marque
                </label>
                <FieldError code={serverErrors.enabled} />
              </div>

              <div role="radiogroup" aria-label="Mode de vitesse" className="flex flex-col sm:flex-row gap-1.5 sm:gap-4">
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name={`${uid}-mode`} checked={!form.custom} onChange={() => set({ custom: false })} data-speed-global />
                  Utiliser les réglages globaux
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name={`${uid}-mode`} checked={form.custom} onChange={() => set({ custom: true })} data-speed-custom />
                  Vitesse personnalisée
                </label>
              </div>

              {form.custom && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {FIELDS.map(({ key, label, max, minAllowed, attr }) => {
                      const id = `${uid}-${key}`;
                      const code = fieldError(key);
                      return (
                        <div key={key} className="min-w-0">
                          <label htmlFor={id} className="block text-[11px] font-semibold text-gray-600 mb-1">{label}</label>
                          <input id={id} className={`${inputCls} ${code ? "border-red-300" : ""}`} type="number" inputMode="numeric"
                            min={minAllowed} max={max} step="1" value={form[key]}
                            aria-invalid={code ? true : undefined} aria-describedby={`${id}-hint`}
                            onChange={(e) => set({ [key]: e.target.value })} {...{ [attr]: true }} />
                          <span id={`${id}-hint`} className="block text-[10px] text-gray-400 mt-0.5">{minAllowed} à {max}</span>
                          <FieldError code={code} />
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-gray-700" data-speed-effective aria-live="polite">
                    {effective
                      ? `Plage effective sur 24 h glissantes : ${effective.min}–${effective.max} commandes`
                      : missing ? "Renseignez les 4 limites pour voir la plage effective sur 24 h glissantes."
                        : "Plage effective sur 24 h glissantes : —"}
                  </p>
                  {limitsError && (
                    <p className="text-[11px] text-red-600" role="alert" data-speed-limits-error={limitsError}>
                      {errText(limitsError)}
                      {limitsError === "DAY_RANGE_TOO_NARROW" && gap
                        ? ` (plage effective ${gap.min}–${gap.max} : écart ${gap.max - gap.min}, il faut au moins ${gap.need}).`
                        : ""}
                    </p>
                  )}
                </div>
              )}

              {topError && <p className="text-xs text-red-600" role="alert">{topError}</p>}
              {success && <p className="text-xs text-emerald-700" role="status">{success}</p>}

              {editable && (
                <button type="submit" disabled={saving || invalid} className={btnPrimary} data-speed-save>
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Enregistrer
                </button>
              )}
            </fieldset>
          </form>

          <div className="border-t border-gray-200 pt-2">
            <button type="button" onClick={() => setHistoryOpen((o) => !o)} aria-expanded={historyOpen} className={btnGhost}>
              Historique ({history.length})
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
            </button>
            {historyOpen && (
              history.length === 0
                ? <p className="text-[11px] text-gray-500 mt-2">Aucune configuration propre : réglages globaux.</p>
                : (
                  <ul className="mt-2 space-y-1" data-speed-history>
                    {history.map((v) => {
                      const future = new Date(v.effectiveFrom).getTime() > nowMs;
                      const inForce = data.current && v.effectiveFrom === data.current.effectiveFrom;
                      return (
                        <li key={`${v.effectiveFrom}-${v.savedAt}`} className="text-[11px] text-gray-600 break-words">
                          <span className="font-semibold text-gray-700">{fmtDate(v.effectiveFrom)}</span>
                          {future ? " (à venir)" : inForce ? " (en vigueur)" : ""}
                          {" · "}{describe(v, null).text}
                          {v.effective ? ` · plage effective ${v.effective.min}–${v.effective.max} / 24 h` : ""}
                          {" · par "}{v.savedBy || "—"}{v.savedAt ? ` le ${fmtDate(v.savedAt)}` : ""}
                        </li>
                      );
                    })}
                  </ul>
                )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
