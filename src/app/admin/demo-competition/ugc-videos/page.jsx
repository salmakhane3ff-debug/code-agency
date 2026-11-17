"use client";
// /admin/demo-competition/ugc-videos — UGC Videos module of the Demo Competition (SIMULATION ONLY).
// Demo videos owned by demo members, simulated daily sales and simulated rewards (5 / 6 / 7 DH per sale).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Loader2, RefreshCw, Pencil, Archive, ArchiveRestore, Play, Sparkles, Save } from "lucide-react";
import { UGC_DEFAULTS, UGC_LIMITS } from "@/lib/demoCompUgc";
import {
  dcApi, toInt, PageHeader, SimulationNotice, Counter, Notice, Avatar, inputCls, btnPrimary, btnGhost, btnDanger, cardCls,
  fmtDh, fmtInt, fmtDateTime,
} from "../_components/ui";
import { UGC, Switch, SimBadge, UgcSimulationNote, UgcFieldError, VideoBadges, Thumb, ugcErrorText } from "./_components/ugcUi";
import VideoEditor from "./_components/VideoEditor";

const FILTERS = [
  ["current", "Toutes (non retirées)", (v) => !v.archivedAt],
  ["active", "Actives", (v) => !v.archivedAt && v.active],
  ["inactive", "Désactivées", (v) => !v.archivedAt && !v.active],
  ["nofile", "Sans fichier vidéo", (v) => !v.archivedAt && !v.videoUrl],
  ["archived", "Retirées", (v) => !!v.archivedAt],
];

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 min-w-0">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="text-sm font-bold text-gray-900 break-words">{value}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

function VideoRow({ v, enabled, busy, restoreBlock, onEdit, onToggle, onArchive, onRestore }) {
  const s = v.stats || {};
  const rowBusy = busy === `toggle:${v.id}` || busy === `archive:${v.id}` || busy === `restore:${v.id}`;
  return (
    <li className={`${cardCls} p-3 flex flex-col gap-3 ${v.archivedAt ? "opacity-80" : ""}`} data-ugc-admin-row={v.id}>
      <div className="flex gap-3 min-w-0">
        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-xs font-bold text-gray-700">{v.rank ? `#${v.rank}` : "—"}</span>
          <Thumb url={v.thumbnailUrl} title={v.title} />
        </div>
        <div className="flex-1 min-w-0 space-y-1.5">
          <button type="button" className="block text-start text-sm font-bold text-gray-900 hover:text-blue-700 break-words" onClick={onEdit}>{v.title}</button>
          <div className="flex items-center gap-2 min-w-0">
            <Avatar src={v.owner?.avatarUrl} name={v.owner?.name} size={24} />
            <span className="text-xs text-gray-600 truncate">{v.owner?.name || "—"}</span>
          </div>
          <VideoBadges v={v} enabled={enabled} />
          <p className="text-[11px] text-gray-500">
            {v.minDailySales}–{v.maxDailySales} ventes simulées / jour · <strong className="text-gray-700">{v.rewardPerSaleMad} DH / vente</strong> · ordre {v.sortOrder}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 text-center">
        {[["Ventes 24 h", fmtInt(s.sales24h)], ["Ventes 7 j", fmtInt(s.sales7d)], ["Ventes 30 j", fmtInt(s.sales30d)],
          ["Récomp. 30 j", fmtDh(s.reward30dCents)], ["Récomp. total", fmtDh(s.rewardAllCents)], ["Dernière vente", fmtDateTime(v.lastSaleAt)]].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-gray-50 border border-gray-100 px-1.5 py-1 min-w-0">
            <p className="text-[10px] text-gray-500 truncate">{label}</p>
            <p className="text-xs font-semibold text-gray-900 break-words">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {v.archivedAt ? (
          <span className="text-[11px] text-gray-500">Retirée le {fmtDateTime(v.archivedAt)} · historique conservé</span>
        ) : (
          <span className="inline-flex items-center gap-2 text-xs text-gray-700">
            <Switch
              checked={v.active} onChange={onToggle} disabled={!!busy} label={`Activer / désactiver ${v.title}`}
              data-ugc-admin-toggle={v.id}
            />
            {busy === `toggle:${v.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : v.active ? "Active" : "Désactivée"}
          </span>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnGhost} onClick={onEdit} disabled={rowBusy}>
            <Pencil className="w-3.5 h-3.5" /> {v.archivedAt ? "Détails" : "Modifier"}
          </button>
          {v.archivedAt ? (
            <button type="button" className={btnGhost} onClick={onRestore} disabled={!!busy || !!restoreBlock} title={restoreBlock || "Revient désactivée, à réactiver ensuite"}>
              {busy === `restore:${v.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArchiveRestore className="w-3.5 h-3.5" />} Restaurer
            </button>
          ) : (
            <button type="button" className={btnDanger} onClick={onArchive} disabled={!!busy}>
              {busy === `archive:${v.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />} Retirer
            </button>
          )}
        </div>
      </div>
      {v.archivedAt && restoreBlock && <p className="text-[11px] text-amber-700">{restoreBlock}</p>}
    </li>
  );
}

export default function DemoUgcVideosPage() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null); // "module" | "target" | "generate" | "run" | "toggle:<id>" | "archive:<id>" | "restore:<id>"
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("current");
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = create, id = edit
  const [target, setTarget] = useState("");
  const [targetError, setTargetError] = useState(null);

  const load = useCallback(async (resetTarget = false) => {
    setRefreshing(true);
    const r = await dcApi(UGC);
    setRefreshing(false);
    if (!r.ok) { setLoadError(ugcErrorText(r)); return; }
    setLoadError(null);
    setState(r.data);
    if (resetTarget) setTarget(String(r.data?.settings?.targetVideoCount ?? UGC_DEFAULTS.targetVideoCount));
  }, []);

  useEffect(() => { load(true); }, [load]);

  const settings = state?.settings;
  const limits = state?.limits || {};
  const counts = state?.counts || {};
  const maxVideos = limits.maxVideos ?? UGC_LIMITS.maxVideos;
  const videos = Array.isArray(state?.videos) ? state.videos : [];
  const members = Array.isArray(state?.members) ? state.members : [];
  const enabled = !!settings?.enabled;
  const full = (counts.videos ?? 0) >= maxVideos;
  const noMembers = !!state && members.length === 0;
  const savedTarget = settings?.targetVideoCount ?? UGC_DEFAULTS.targetVideoCount;
  const targetDirty = String(savedTarget) !== String(target).trim();
  const shownTarget = Number.isInteger(toInt(target)) ? toInt(target) : savedTarget;
  const noFile = videos.filter((v) => !v.archivedAt && !v.videoUrl).length;
  const [, , pass] = FILTERS.find(([k]) => k === filter) || FILTERS[0];
  const shown = videos.filter(pass);

  const toggleModule = async () => {
    setBusy("module");
    const r = await dcApi(UGC, { method: "PATCH", body: { enabled: !enabled } });
    setBusy(null);
    if (r.ok) {
      setNotice({ ok: true, text: r.data.settings.enabled
        ? "Module UGC Videos activé : la simulation reprend à partir de maintenant (la période désactivée n'est pas rattrapée)."
        : "Module UGC Videos désactivé : plus aucune vente simulée et le classement public est vide tant qu'il reste désactivé." });
    } else setNotice({ ok: false, text: ugcErrorText(r) });
    load();
  };

  /** PATCH targetVideoCount (1–100). → true when saved. */
  const saveTarget = async () => {
    const n = toInt(target);
    const min = limits.targetMin ?? UGC_LIMITS.targetMin, max = limits.targetMax ?? UGC_LIMITS.targetMax;
    if (!Number.isInteger(n) || n < min || n > max) { setTargetError("INVALID_TARGET_COUNT"); return false; }
    setBusy("target");
    const r = await dcApi(UGC, { method: "PATCH", body: { targetVideoCount: n } });
    setBusy(null);
    if (!r.ok) { setTargetError(r.fields?.targetVideoCount || null); setNotice({ ok: false, text: ugcErrorText(r) }); return false; }
    setTargetError(null);
    setTarget(String(r.data.settings.targetVideoCount));
    setState((st) => (st ? { ...st, settings: r.data.settings } : st));
    return true;
  };

  const generate = async () => {
    if (!window.confirm(`Générer des vidéos démo jusqu'à ${shownTarget} vidéos non retirées ?\n\nLes vidéos manquantes sont créées avec des titres provisoires, réparties entre les membres démo, avec 30 jours d'historique de ventes simulées. Elles n'ont PAS de fichier vidéo : elles restent non visibles publiquement jusqu'au téléversement d'un fichier. Relancer ne crée rien de plus une fois la cible atteinte. Données SIMULÉES uniquement.`)) return;
    if (targetDirty && !(await saveTarget())) return;
    setBusy("generate");
    const r = await dcApi(`${UGC}/generate`, { method: "POST" });
    setBusy(null);
    if (r.ok) {
      const d = r.data;
      setNotice({ ok: true, text: d.created
        ? `${d.created} vidéo(s) démo créée(s) (cible ${d.target}), ${fmtInt(d.events)} vente(s) simulée(s) générée(s). Téléversez leurs fichiers vidéo pour les rendre visibles.`
        : `Rien à créer : ${d.target} vidéo(s) non retirée(s) existent déjà (cible atteinte).` });
    } else setNotice({ ok: false, text: ugcErrorText(r) });
    load();
  };

  // Module OFF → the API answers 409 UGC_DISABLED; the button is disabled anyway.
  const run = async () => {
    setBusy("run");
    const r = await dcApi(`${UGC}/run`, { method: "POST" });
    setBusy(null);
    if (r.ok) setNotice({ ok: !r.data.error, text: r.data.error ? `Exécution terminée avec une erreur : ${r.data.error}` : `Exécution terminée : ${fmtInt(r.data.events)} vente(s) simulée(s) générée(s) sur ${fmtInt(r.data.videos)} vidéo(s).` });
    else setNotice({ ok: false, text: ugcErrorText(r) });
    load();
  };

  const toggleVideo = async (v) => {
    setBusy(`toggle:${v.id}`);
    const r = await dcApi(`${UGC}/videos/${v.id}`, { method: "PATCH", body: { active: !v.active } });
    setBusy(null);
    if (!r.ok) setNotice({ ok: false, text: ugcErrorText(r) });
    load();
  };

  const archiveVideo = async (v) => {
    if (!window.confirm(`Retirer la vidéo démo « ${v.title} » ?\n\nElle sera désactivée et disparaîtra du classement public UGC Videos. Rien n'est supprimé : son historique de ventes simulées est conservé et vous pourrez la restaurer plus tard (elle reviendra désactivée).`)) return;
    setBusy(`archive:${v.id}`);
    const r = await dcApi(`${UGC}/videos/${v.id}/archive`, { method: "POST" });
    setBusy(null);
    setNotice(r.ok ? { ok: true, text: `« ${v.title} » retirée : historique conservé, visible dans le filtre « Retirées » (restaurable).` } : { ok: false, text: ugcErrorText(r) });
    load();
  };

  const restoreVideo = async (v) => {
    setBusy(`restore:${v.id}`);
    const r = await dcApi(`${UGC}/videos/${v.id}/restore`, { method: "POST" });
    setBusy(null);
    setNotice(r.ok ? { ok: true, text: `« ${v.title} » restaurée, mais désactivée : activez-la pour la remettre dans le classement.` } : { ok: false, text: ugcErrorText(r) });
    load();
  };

  const restoreBlock = (v) => (full ? `Limite de ${maxVideos} vidéos non retirées atteinte.` : v.owner?.archivedAt ? "Propriétaire archivé : restaurez d'abord le membre démo." : null);

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-4 overflow-x-hidden">
      <PageHeader title="Demo UGC Videos" subtitle="Classement de vidéos UGC fictives : ventes et récompenses simulées sur 30 jours glissants.">
        <SimBadge />
        <Counter value={counts.videos ?? 0} max={maxVideos} label="vidéos" />
        <button type="button" className={btnGhost} onClick={() => load()} disabled={refreshing}>
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Actualiser
        </button>
        <button
          type="button" className={btnPrimary} disabled={!state || full || noMembers} onClick={() => setEditing(null)}
          title={full ? `Limite de ${maxVideos} vidéos démo atteinte` : noMembers ? "Créez d'abord un membre démo" : undefined}
        >
          <Plus className="w-3.5 h-3.5" /> Nouvelle vidéo
        </button>
      </PageHeader>
      <SimulationNotice />
      <UgcSimulationNote />
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {!state ? (
        <div className={`${cardCls} p-8 flex flex-col items-center gap-3 text-sm text-gray-500`}>
          {loadError ? (
            <>
              <Notice notice={{ ok: false, text: loadError }} />
              <button type="button" className={btnGhost} onClick={() => load(true)} disabled={refreshing}><RefreshCw className="w-3.5 h-3.5" /> Réessayer</button>
            </>
          ) : <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}
        </div>
      ) : (
        <>
          {/* ── Module card ── */}
          <section className={`${cardCls} p-4 space-y-4`} data-ugc-module>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-gray-900">Module UGC Videos (démo)</h2>
                <p className="text-[11px] text-gray-500">Désactivé = aucune vente simulée et classement public vide ; à la réactivation, la simulation reprend à l&apos;heure actuelle (pas de rattrapage).</p>
              </div>
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-gray-700">
                <Switch checked={enabled} onChange={toggleModule} disabled={!!busy} label="Activer le module UGC Videos" data-ugc-admin-module-switch />
                {busy === "module" ? <Loader2 className="w-4 h-4 animate-spin" /> : enabled ? <span className="text-green-600">Activé</span> : <span className="text-gray-400">Désactivé</span>}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Vidéos (non retirées)" value={`${fmtInt(counts.videos)} / ${maxVideos}`} sub={`${fmtInt(counts.archived)} retirée(s)`} />
              <Stat label="Actives" value={fmtInt(counts.active)} />
              <Stat label="Listées publiquement" value={fmtInt(counts.listed)} sub={enabled ? undefined : "module désactivé : aucune"} />
              <Stat label="Sans fichier vidéo" value={fmtInt(noFile)} sub="non visibles" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <Stat label="Dernière exécution" value={fmtDateTime(settings.lastRunAt)} sub={`${fmtInt(settings.lastRunEvents)} vente(s) simulée(s) générée(s)`} />
              <Stat
                label={enabled ? "Activé depuis" : "Désactivé depuis"} value={fmtDateTime(enabled ? settings.resumedAt : settings.pausedAt)}
                sub={settings.initializedAt ? `Première génération : ${fmtDateTime(settings.initializedAt)}` : "Aucune génération pour l'instant"}
              />
            </div>
            {settings.lastError && (
              <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 break-words" data-ugc-last-error>Dernière erreur : {settings.lastError}</p>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <div className="w-36">
                <label className="block text-xs font-semibold text-gray-600 mb-1" htmlFor="ugc-target">Nombre cible de vidéos</label>
                <input
                  id="ugc-target" className={inputCls} inputMode="numeric" value={target} disabled={!!busy}
                  onChange={(e) => { setTarget(e.target.value); setTargetError(null); }}
                />
              </div>
              <button type="button" className={btnGhost} onClick={saveTarget} disabled={!!busy || !targetDirty}>
                {busy === "target" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Enregistrer la cible
              </button>
              <button type="button" className={btnPrimary} onClick={generate} disabled={!!busy || noMembers} title={noMembers ? "Créez d'abord un membre démo" : undefined}>
                {busy === "generate" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Générer jusqu&apos;à {shownTarget} vidéos
              </button>
              <button type="button" className={btnGhost} onClick={run} disabled={!!busy || !enabled} title={enabled ? undefined : "Activez d'abord le module"}>
                {busy === "run" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Exécuter maintenant
              </button>
            </div>
            <UgcFieldError code={targetError} />
            <p className="text-[11px] text-gray-500 leading-relaxed">
              Cible : {limits.targetMin ?? UGC_LIMITS.targetMin} à {limits.targetMax ?? UGC_LIMITS.targetMax} (défaut {UGC_DEFAULTS.targetVideoCount}). « Générer » crée
              uniquement les vidéos manquantes (titres provisoires, propriétaires répartis entre les membres démo, 30 jours d&apos;historique simulé)
              — relancer ne crée rien de plus. Les vidéos générées n&apos;ont pas de fichier : elles restent <strong>non visibles</strong> jusqu&apos;au
              téléversement. « Exécuter maintenant » génère les ventes simulées dues (module activé uniquement).
            </p>
            {noMembers && (
              <p className="text-xs text-amber-800">
                Aucun membre démo non archivé : <Link href="/admin/demo-competition/members" className="underline">créez des membres démo</Link> (propriétaires des vidéos) avant de générer ou créer des vidéos.
              </p>
            )}
          </section>

          {/* ── Video list ── */}
          <section className="space-y-3">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filtrer les vidéos">
              {FILTERS.map(([key, label, fn]) => (
                <button
                  key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${filter === key ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"}`}
                >
                  {label} ({videos.filter(fn).length})
                </button>
              ))}
            </div>
            {filter === "archived" && (
              <p className="text-[11px] text-gray-500">Vidéos retirées : hors classement public, historique conservé, non comptées dans la limite de {maxVideos}. Elles reviennent désactivées une fois restaurées.</p>
            )}

            {videos.length === 0 ? (
              <div className={`${cardCls} p-8 text-center text-sm text-gray-500`}>
                Aucune vidéo UGC démo. Créez-en une avec « Nouvelle vidéo » ou utilisez « Générer jusqu&apos;à {shownTarget} vidéos ».
              </div>
            ) : shown.length === 0 ? (
              <div className={`${cardCls} p-8 text-center text-sm text-gray-500`}>Aucune vidéo dans ce filtre.</div>
            ) : (
              <ul className="space-y-2">
                {shown.map((v) => (
                  <VideoRow
                    key={v.id} v={v} enabled={enabled} busy={busy} restoreBlock={v.archivedAt ? restoreBlock(v) : null}
                    onEdit={() => setEditing(v.id)} onToggle={() => toggleVideo(v)} onArchive={() => archiveVideo(v)} onRestore={() => restoreVideo(v)}
                  />
                ))}
              </ul>
            )}
            <p className="text-[11px] text-gray-500">
              Ordre = rang du classement public (récompense simulée sur 30 jours glissants), puis ordre d&apos;affichage pour les vidéos non listées.
            </p>
          </section>
        </>
      )}

      {editing !== undefined && state && (
        <VideoEditor
          key={editing ?? "new"}
          id={editing}
          state={state}
          onClose={() => setEditing(undefined)}
          onChanged={() => load()}
          onCreated={(id) => { setNotice({ ok: true, text: "Vidéo démo créée (30 jours de ventes simulées générés). Ajoutez son fichier vidéo pour la rendre visible." }); load(); setEditing(id || undefined); }}
        />
      )}
    </div>
  );
}
