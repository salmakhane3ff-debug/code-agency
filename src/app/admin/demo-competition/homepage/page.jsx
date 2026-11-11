"use client";
// /admin/demo-competition/homepage — the two Demo Competition sections ("top_members", "top_brands") inside the
// EXISTING homepage builder layout (Setting row homepage_layout). Only these two section types are touched;
// every other section is preserved as is (id, type, visible, data, relative order).
// Reads / writes go through the admin layout API with an optimistic-concurrency revision shared with the Homepage
// Builder: a save made meanwhile elsewhere answers 409 LAYOUT_CONFLICT and nothing is overwritten.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Save, Eye, EyeOff, Plus, RefreshCw, AlertTriangle } from "lucide-react";
import {
  DEMO_HOMEPAGE_TYPES, TITLE_MAX, asSections, addSection, setSectionVisible, updateSectionData,
  describeSection, finalizeSections, preservesOtherSections,
} from "@/lib/demoCompetition/homepageSections";
import { PageHeader, SimulationNotice, Notice, Field, Toggle, inputCls, btnPrimary, btnGhost, cardCls } from "../_components/ui";

/** Admin layout API: GET → { sections: Array|null, revision }; PUT { sections, revision } → 200 | 409 LAYOUT_CONFLICT | 400 INVALID_LAYOUT. */
const LAYOUT_URL = "/api/admin/homepage-layout";

const CONFLICT_TEXT = "La mise en page a été modifiée ailleurs (ex. Homepage Builder) depuis le chargement. La dernière version a été rechargée : refaites vos changements.";

/** One request to the layout API → { ok, status, data } (status 0 = network error). */
async function layoutRequest(method = "GET", body) {
  try {
    const res = await fetch(LAYOUT_URL, {
      method,
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

const saveErrorText = (r) => (r.status === 401 || r.status === 403 ? "Session admin expirée — reconnectez-vous."
  : r.data?.code === "INVALID_LAYOUT" ? "Layout refusé par le serveur (format invalide)."
    : r.status === 0 ? "Erreur réseau." : `Échec de l'enregistrement (${r.status}).`);

function SectionCard({ type, sections, onChange, canAdd }) {
  const meta = DEMO_HOMEPAGE_TYPES[type];
  const d = describeSection(sections, type);
  const [countInput, setCountInput] = useState(null);

  if (!d.present) {
    return (
      <section className={`${cardCls} p-4 space-y-2`}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-gray-900">{meta.label} <code className="text-[11px] text-gray-400">{type}</code></h2>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">Absente du layout</span>
        </div>
        <p className="text-xs text-gray-500">Cette section n&apos;est pas dans la page d&apos;accueil. L&apos;ajout la place à la fin du layout (visible, {meta.defaultCount} profils).</p>
        <button type="button" className={btnPrimary} disabled={!canAdd} onClick={() => onChange(addSection(sections, type, { nowMs: Date.now(), seq: 1 }))}>
          <Plus className="w-3.5 h-3.5" /> Ajouter à la page d&apos;accueil
        </button>
      </section>
    );
  }

  const commitCount = (raw) => { setCountInput(null); onChange(updateSectionData(sections, type, { previewCount: raw })); };

  return (
    <section className={`${cardCls} p-4 space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-900">{meta.label} <code className="text-[11px] text-gray-400">{type}</code></h2>
        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${d.visible ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-500 border-gray-200"}`} data-dashboard-visibility={d.visible ? "visible" : "hidden"}>
          {d.visible ? "Affichée sur le tableau de bord affilié" : "Masquée du tableau de bord affilié"}
        </span>
      </div>
      {d.duplicates > 0 && (
        <p className="text-[11px] text-amber-700">Le layout contient {d.duplicates} autre(s) section(s) {type} : seule la première est modifiée ici (les autres restent gérées dans le Homepage Builder).</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnGhost} onClick={() => onChange(setSectionVisible(sections, type, !d.visible))}>
          {d.visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />} {d.visible ? "Masquer" : "Afficher"}
        </button>
      </div>
      <p className="text-[11px] text-gray-500">Position fixe sur le tableau de bord affilié (Top Members puis Top Brands, sous l&apos;activité en direct).</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Titre (optionnel)" hint="Vide = titre par défaut de la section.">
          <input className={inputCls} maxLength={TITLE_MAX} value={d.title} onChange={(e) => onChange(updateSectionData(sections, type, { title: e.target.value }))} />
        </Field>
        <Field label={`Nombre de profils affichés (${meta.min} à ${meta.max})`}>
          <input
            type="number" min={meta.min} max={meta.max} className={inputCls}
            value={countInput ?? String(d.previewCount)}
            onChange={(e) => setCountInput(e.target.value)}
            onBlur={(e) => commitCount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitCount(e.currentTarget.value); }}
          />
        </Field>
      </div>
      <Toggle checked={d.showViewAll} onChange={(v) => onChange(updateSectionData(sections, type, { showViewAll: v }))} label="Afficher le lien « Voir tout »" />
    </section>
  );
}

export default function DemoHomepageSettingsPage() {
  const [loaded, setLoaded] = useState(false);
  const [serverSections, setServerSections] = useState(null); // sections as loaded / last saved (null = no custom layout yet)
  const [revision, setRevision] = useState(null);
  const [sections, setSections] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  /** Adopt a server state { sections, revision } (GET, PUT 200 or the current state sent with a 409). */
  const adopt = useCallback((data) => {
    const raw = Array.isArray(data?.sections) ? data.sections : null;
    setServerSections(raw);
    setSections(asSections(raw));
    setRevision(typeof data?.revision === "string" ? data.revision : null);
    setLoaded(true);
  }, []);

  const load = useCallback(async () => {
    const r = await layoutRequest("GET");
    if (r.ok && typeof r.data?.revision === "string") { adopt(r.data); setLoadError(null); return true; }
    setLoadError(r.status === 401 || r.status === 403 ? "Session admin expirée — reconnectez-vous." : "Impossible de lire le layout de la page d'accueil.");
    return false;
  }, [adopt]);

  useEffect(() => { load(); }, [load]);

  // The public homepage falls back to its default template when no layout (or an empty one) is saved.
  const hasLayout = asSections(serverSections).length > 0;
  const baseline = useMemo(() => JSON.stringify(asSections(serverSections)), [serverSections]);
  const dirty = useMemo(() => JSON.stringify(sections) !== baseline, [sections, baseline]);

  const save = async () => {
    const next = finalizeSections(sections);
    // Guard kept: this page never changes any section other than top_members / top_brands.
    if (!preservesOtherSections(serverSections, next)) {
      setNotice({ ok: false, text: "Enregistrement annulé : les autres sections auraient été modifiées." });
      return;
    }
    setSaving(true);
    setNotice(null);
    const r = await layoutRequest("PUT", { sections: next, revision });
    setSaving(false);
    if (r.ok) {
      adopt(r.data && Array.isArray(r.data.sections) ? r.data : { sections: next, revision: r.data?.revision });
      setNotice({ ok: true, text: "Page d'accueil enregistrée." });
    } else if (r.status === 409 && r.data?.code === "LAYOUT_CONFLICT") {
      // Someone saved meanwhile (Homepage Builder…): never overwrite — reload the current server state.
      if (typeof r.data.revision === "string") adopt(r.data); else await load();
      setNotice({ ok: false, text: CONFLICT_TEXT });
    } else {
      setNotice({ ok: false, text: saveErrorText(r) });
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-4">
      <PageHeader title="Homepage Settings" subtitle="Sections Top Members et Top Brands du layout existant. Titre, nombre affiché et lien « Voir tout » s'appliquent au tableau de bord affilié (ces sections ne sont plus affichées sur la page d'accueil).">
        <button type="button" className={btnGhost} onClick={() => { setNotice(null); load(); }} disabled={saving}><RefreshCw className="w-3.5 h-3.5" /> Recharger</button>
        <button type="button" className={btnPrimary} onClick={save} disabled={saving || !dirty || !loaded || !revision}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Enregistrer
        </button>
      </PageHeader>
      <SimulationNotice />
      <p className="text-xs text-gray-500">
        Ces sections affichent des classements de <strong>démonstration</strong> (profils et gains simulés). Les autres sections se gèrent dans le{" "}
        <Link href="/admin/homepage-builder" className="text-blue-600 hover:underline">Homepage Builder</Link> ; elles ne sont jamais modifiées ici.
      </p>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      {dirty && <p className="text-[11px] text-amber-700">Modifications non enregistrées.</p>}

      {!loaded ? (
        <div className="flex justify-center py-10">
          {loadError ? <Notice notice={{ ok: false, text: loadError }} /> : <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}
        </div>
      ) : (
        <>
          {!hasLayout && (
            <div className="flex gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Aucun layout personnalisé n&apos;est enregistré : la page d&apos;accueil utilise le modèle par défaut. Ajouter une section ici
                remplacerait toute la page par cette seule section. Enregistrez d&apos;abord un layout dans le{" "}
                <Link href="/admin/homepage-builder" className="underline">Homepage Builder</Link>, puis revenez ici.
              </span>
            </div>
          )}
          {Object.keys(DEMO_HOMEPAGE_TYPES).map((type) => (
            <SectionCard key={type} type={type} sections={sections} onChange={setSections} canAdd={hasLayout} />
          ))}
        </>
      )}
    </div>
  );
}
