"use client";
// /admin/demo-competition/engine — Live Engine of the Demo Competition (SIMULATION ONLY).

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Sparkles, Save, Power, RefreshCw } from "lucide-react";
import { MAX_MEMBERS, MAX_BRANDS, LIMITS } from "@/lib/demoCompetition/engine";
import {
  dcApi, dhToCents, percentToBps, centsToInput, bpsToInput, PageHeader, SimulationNotice, Notice, Field, Toggle,
  inputCls, btnPrimary, btnGhost, cardCls, fmtDh, fmtInt, fmtDateTime, previewPerOrder,
} from "../_components/ui";

/** One allocation on its own: 1..10000 bps (0,01 à 100 %). There is no combined member + brand cap. */
const bpsOk = (b) => b !== null && b >= LIMITS.bpsMin && b <= LIMITS.bpsMax;

const formFrom = (e) => ({
  priceDh: centsToInput(e.defaultPriceCents),
  memberPct: bpsToInput(e.defaultMemberBps),
  brandPct: bpsToInput(e.defaultBrandBps),
});

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="text-sm font-bold text-gray-900 break-words">{value}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

export default function DemoEnginePage() {
  const [state, setState] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null); // "toggle" | "run" | "init" | "defaults"
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async (resetForm = false) => {
    const r = await dcApi("/engine");
    if (!r.ok) { setLoadError(r.error); return; }
    setLoadError(null);
    setState(r.data);
    if (resetForm) setForm(formFrom(r.data.engine));
  }, []);

  useEffect(() => { load(true); }, [load]);

  const toggle = async () => {
    setBusy("toggle");
    const r = await dcApi("/engine", { method: "PATCH", body: { enabled: !state.engine.enabled } });
    setBusy(null);
    if (r.ok) {
      setNotice({ ok: true, text: r.data.engine.enabled
        ? "Moteur démo activé : la simulation reprend à partir de maintenant (la période désactivée n'est pas rattrapée)."
        : "Moteur démo désactivé : aucune activité démo n'est générée tant qu'il reste désactivé." });
      load();
    }
    else setNotice({ ok: false, text: r.error });
  };

  // Engine OFF → the API answers 409 ENGINE_DISABLED (mapped to French in ui.jsx); the button is disabled anyway.
  const run = async () => {
    setBusy("run");
    const r = await dcApi("/engine/run", { method: "POST" });
    setBusy(null);
    if (r.ok) setNotice({ ok: !r.data.error, text: r.data.error ? `Exécution terminée avec une erreur : ${r.data.error}` : `Exécution terminée : ${fmtInt(r.data.events)} événement(s) démo généré(s) sur ${fmtInt(r.data.profiles)} profil(s).` });
    else setNotice({ ok: false, text: r.error });
    load();
  };

  const initialize = async () => {
    const c = state.counts;
    if (!window.confirm(`Créer les profils démo manquants (${Math.max(0, MAX_MEMBERS - c.members)} membre(s), ${Math.max(0, MAX_BRANDS - c.brands)} marque(s)) avec des noms provisoires modifiables ?\n\nChaque profil créé reçoit immédiatement ses 30 jours d'historique démo, même si le moteur est désactivé. Les profils existants (archivés compris) ne sont pas modifiés. Données SIMULÉES uniquement.`)) return;
    setBusy("init");
    const r = await dcApi("/engine/initialize", { method: "POST" });
    setBusy(null);
    if (r.ok) {
      const d = r.data;
      setNotice({ ok: !d.error, text: `Initialisation : ${d.createdMembers} membre(s) et ${d.createdBrands} marque(s) créés, ${fmtInt(d.events)} événement(s) démo générés.${d.error ? ` Erreur : ${d.error}` : ""}` });
    } else setNotice({ ok: false, text: r.error });
    load();
  };

  const saveDefaults = async () => {
    const body = {
      defaultPriceCents: dhToCents(form.priceDh),
      defaultMemberBps: percentToBps(form.memberPct),
      defaultBrandBps: percentToBps(form.brandPct),
    };
    // Member and brand allocations are two separate demo sales streams: each one is validated on its own (0,01 à 100 %).
    const local = {};
    if (body.defaultPriceCents === null) local.defaultPriceCents = "INVALID_PRICE";
    if (!bpsOk(body.defaultMemberBps)) local.defaultMemberBps = "INVALID_ALLOCATION";
    if (!bpsOk(body.defaultBrandBps)) local.defaultBrandBps = "INVALID_ALLOCATION";
    if (Object.keys(local).length) { setErrors(local); setNotice({ ok: false, text: "Corrigez les champs signalés." }); return; }
    setBusy("defaults");
    const r = await dcApi("/engine", { method: "PATCH", body });
    setBusy(null);
    if (r.ok) { setErrors({}); setNotice({ ok: true, text: "Valeurs par défaut enregistrées (utilisées pour les NOUVEAUX profils démo)." }); load(true); }
    else { setErrors(r.fields); setNotice({ ok: false, text: r.error }); }
  };

  const set = (k, v, errKey) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [errKey]: undefined })); };

  if (!state || !form) {
    return (
      <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-4">
        <PageHeader title="Live Engine" />
        <SimulationNotice />
        <div className="flex justify-center py-10">
          {loadError ? <Notice notice={{ ok: false, text: loadError }} /> : <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}
        </div>
      </div>
    );
  }

  const { engine, counts } = state;
  const limits = state.limits || { members: MAX_MEMBERS, brands: MAX_BRANDS };
  const complete = counts.members >= limits.members && counts.brands >= limits.brands;
  const pm = previewPerOrder(form.priceDh, form.memberPct);
  const pb = previewPerOrder(form.priceDh, form.brandPct);

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-4">
      <PageHeader title="Live Engine" subtitle="Génération côté serveur des événements démo (commandes et gains simulés).">
        <button type="button" className={btnGhost} onClick={() => load()} disabled={!!busy}><RefreshCw className="w-3.5 h-3.5" /> Actualiser</button>
      </PageHeader>
      <SimulationNotice />
      <Notice notice={notice} onClose={() => setNotice(null)} />

      <section className={`${cardCls} p-4 space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${engine.enabled ? "bg-green-500 animate-pulse" : "bg-gray-300"}`} />
            <h2 className="text-sm font-bold text-gray-900">Moteur démo {engine.enabled ? "actif" : "arrêté"}</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Toggle checked={engine.enabled} onChange={toggle} disabled={!!busy} label={<span className="text-xs font-semibold inline-flex items-center gap-1"><Power className="w-3.5 h-3.5" />{engine.enabled ? "Activé" : "Désactivé"}</span>} />
            <button type="button" className={btnPrimary} onClick={run} disabled={!!busy || !engine.enabled} title={engine.enabled ? undefined : "Activez d'abord le moteur"}>
              {busy === "run" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Exécuter maintenant
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Stat label="Membres démo" value={`${counts.members} / ${limits.members}`} sub={`${fmtInt(counts.archivedMembers)} archivé(s), hors limite`} />
          <Stat label="Marques démo" value={`${counts.brands} / ${limits.brands}`} sub={`${fmtInt(counts.archivedBrands)} archivée(s), hors limite`} />
          <Stat label="Événements démo" value={fmtInt(counts.events)} />
          <Stat label="Initialisé le" value={fmtDateTime(engine.initializedAt)} />
          <Stat label="Dernière exécution" value={fmtDateTime(engine.lastRunAt)} sub={engine.lastRunAt ? `${fmtInt(engine.lastRunEvents)} événement(s) générés` : null} />
          <div className="col-span-2 md:col-span-3">
            <Stat label="Dernière erreur" value={engine.lastError ? <span className="text-red-600 font-medium text-xs">{engine.lastError}</span> : "Aucune"} />
          </div>
        </div>
      </section>

      <section className={`${cardCls} p-4 space-y-3`}>
        <h2 className="text-sm font-bold text-gray-900">Initialiser {MAX_MEMBERS} membres + {MAX_BRANDS} marques avec 30 jours d&apos;historique</h2>
        <p className="text-xs text-gray-500 leading-relaxed">
          Crée uniquement les profils manquants jusqu&apos;à {MAX_MEMBERS} membres et {MAX_BRANDS} marques non archivés (noms provisoires
          modifiables, réglages variés, prix et allocations par défaut ci-dessous). Chaque profil créé reçoit <strong>immédiatement</strong> ses
          30 jours d&apos;historique démo, avec les mêmes règles que la génération en direct, <strong>même si le moteur est désactivé</strong>.
          L&apos;opération est idempotente : les profils existants (archivés compris) ne sont jamais modifiés et la relancer ne crée rien de plus.
        </p>
        <button type="button" className={btnPrimary} onClick={initialize} disabled={!!busy || complete}>
          {busy === "init" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Initialiser {MAX_MEMBERS} membres + {MAX_BRANDS} marques
        </button>
        {complete && <p className="text-[11px] text-gray-500">Déjà complet ({counts.members}/{limits.members} membres, {counts.brands}/{limits.brands} marques) : rien à initialiser.</p>}
      </section>

      <section className={`${cardCls} p-4 space-y-3`}>
        <h2 className="text-sm font-bold text-gray-900">Valeurs par défaut des nouveaux profils</h2>
        <p className="text-xs text-gray-500">Utilisées à la création d&apos;un membre / d&apos;une marque démo (et par l&apos;initialisation). Les profils existants gardent leurs propres réglages.</p>
        <p className="text-xs text-gray-500">
          Allocation membre et allocation marque sont <strong>indépendantes</strong> : ce sont deux flux de ventes démo distincts, chaque valeur
          est validée séparément (0,01 à 100 %). Pour une marque, le reste du prix représente les coûts simulés de livraison, plateforme et confirmation.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Prix par défaut (DH)" error={errors.defaultPriceCents}>
            <input className={inputCls} inputMode="decimal" value={form.priceDh} onChange={(e) => set("priceDh", e.target.value, "defaultPriceCents")} />
          </Field>
          <Field label="Allocation membre par défaut (%)" error={errors.defaultMemberBps} hint={pm ? `1 commande démo = ${fmtDh(pm.earningsCents)}` : null}>
            <input className={inputCls} inputMode="decimal" value={form.memberPct} onChange={(e) => set("memberPct", e.target.value, "defaultMemberBps")} />
          </Field>
          <Field label="Allocation marque par défaut (%)" error={errors.defaultBrandBps} hint={pb ? `1 commande démo = ${fmtDh(pb.earningsCents)}` : null}>
            <input className={inputCls} inputMode="decimal" value={form.brandPct} onChange={(e) => set("brandPct", e.target.value, "defaultBrandBps")} />
          </Field>
        </div>
        <div className="flex justify-end">
          <button type="button" className={btnPrimary} onClick={saveDefaults} disabled={!!busy}>
            {busy === "defaults" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Enregistrer les valeurs par défaut
          </button>
        </div>
      </section>

      <section className={`${cardCls} p-4 space-y-2 text-xs text-gray-600 leading-relaxed`}>
        <h2 className="text-sm font-bold text-gray-900">Fonctionnement</h2>
        <ul className="list-disc ps-5 space-y-1">
          <li>Tout est généré <strong>côté serveur</strong> et de façon <strong>déterministe</strong> : relancer la génération produit exactement les mêmes événements démo (aucun doublon).</li>
          <li>Pour chaque profil et chaque jour (fuseau <strong>Africa/Casablanca</strong>), un plan tire un nombre de commandes démo entre le min et le max du profil, réparties dans la journée (plus d&apos;activité en fin de matinée et le soir).</li>
          <li>Un événement démo ne devient visible qu&apos;une fois son heure passée. Gain d&apos;un événement = quantité × prix × allocation, figés au moment de l&apos;événement.</li>
          <li>Les changements de réglages ne touchent que les <strong>futurs</strong> événements ; le min/max s&apos;applique à partir du jour suivant (Casablanca).</li>
          <li>La génération tourne via le worker <code className="px-1 rounded bg-gray-100">demo-leaderboard-engine</code> ; à défaut, les visites des pages de classement rattrapent les événements dus. « Exécuter maintenant » force un rattrapage immédiat (moteur activé uniquement).</li>
          <li>Moteur désactivé = aucune activité générée pour cette période ; à la réactivation, la simulation reprend à l&apos;heure actuelle (pas de rattrapage). L&apos;historique déjà généré reste affiché.</li>
          <li>Création d&apos;un profil (à la main ou via « Initialiser ») : ses 30 jours d&apos;historique démo sont générés immédiatement, même moteur désactivé.</li>
          <li>Un profil archivé ou désactivé ne génère plus d&apos;événements et n&apos;apparaît pas dans les classements publics ; son historique est conservé.</li>
        </ul>
      </section>
    </div>
  );
}
