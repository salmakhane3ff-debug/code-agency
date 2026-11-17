"use client";
// Create / edit drawer of a demo UGC video (SIMULATION ONLY — no real UGC submission, order, reward or money).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Save, Archive, ArchiveRestore } from "lucide-react";
import { REWARD_CHOICES, UGC_DEFAULTS, UGC_LIMITS } from "@/lib/demoCompUgc";
import { dcApi, toInt, inputCls, btnPrimary, btnDanger, Notice, SimulationNotice, Avatar, fmtDh, fmtInt, fmtDateTime } from "../../_components/ui";
import { Drawer, Section } from "../../_components/ProfileParts";
import { UGC, UgcField, UgcFieldError, Switch, MediaUploader, VideoBadges, SimBadge, UgcSimulationNote, ugcErrorText, DEFAULT_UPLOADS } from "./ugcUi";

function formFrom(v) {
  return {
    title: v?.title ?? "",
    memberId: v?.memberId ?? "",
    active: v ? !!v.active : true,
    minDailySales: String(v?.minDailySales ?? UGC_DEFAULTS.minDailySales),
    maxDailySales: String(v?.maxDailySales ?? UGC_DEFAULTS.maxDailySales),
    rewardPerSaleMad: String(v?.rewardPerSaleMad ?? UGC_DEFAULTS.rewardPerSaleMad),
    sortOrder: v ? String(v.sortOrder ?? 0) : "",
    videoUrl: v?.videoUrl ?? null,
    thumbnailUrl: v?.thumbnailUrl ?? null,
  };
}

/** Form strings → API payload + client-side field errors (same codes as the server). Empty sort order at creation = "at the end". */
function buildPayload(f, creating, salesMax) {
  const errors = {};
  const title = String(f.title || "").trim().replace(/\s+/g, " ");
  if (!title || title.length > UGC_LIMITS.titleMax || /[<>]/.test(title)) errors.title = "INVALID_TITLE";
  if (!f.memberId) errors.memberId = "MEMBER_REQUIRED";
  const min = toInt(f.minDailySales), max = toInt(f.maxDailySales);
  const minOk = Number.isInteger(min) && min >= 0 && min <= salesMax;
  const maxOk = Number.isInteger(max) && max >= 0 && max <= salesMax;
  if (!minOk) errors.minDailySales = "INVALID_MIN_SALES";
  if (!maxOk) errors.maxDailySales = "INVALID_MAX_SALES";
  else if (minOk && max < min) errors.maxDailySales = "MAX_BELOW_MIN";
  const reward = toInt(f.rewardPerSaleMad);
  if (!REWARD_CHOICES.includes(reward)) errors.rewardPerSaleMad = "INVALID_REWARD";
  const payload = {
    title, memberId: f.memberId, active: !!f.active, minDailySales: min, maxDailySales: max, rewardPerSaleMad: reward,
    videoUrl: f.videoUrl || null, thumbnailUrl: f.thumbnailUrl || null,
  };
  if (!(creating && String(f.sortOrder).trim() === "")) {
    const s = toInt(f.sortOrder);
    if (!Number.isInteger(s) || s < 0 || s > UGC_LIMITS.sortOrderMax) errors.sortOrder = "INVALID_SORT_ORDER";
    payload.sortOrder = s;
  }
  return { payload, errors };
}

function Tile({ label, value, sub }) {
  return (
    <div className="rounded-xl bg-gray-50 border border-gray-100 p-2.5 min-w-0">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="text-sm font-bold text-gray-900 break-words">{value}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

/** 30-day history: CSS bars (simulated reward per Casablanca day) + collapsible table. */
function DailyHistory({ daily }) {
  const rows = Array.isArray(daily) ? daily : [];
  if (!rows.length) return <p className="text-xs text-gray-400">Aucun historique.</p>;
  const max = Math.max(1, ...rows.map((d) => d.rewardCents || 0));
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-[2px] h-24 border-b border-gray-100" aria-label="Récompenses simulées sur 30 jours">
        {rows.map((d) => (
          <div key={d.day} className="flex-1 flex flex-col justify-end min-w-[3px]" title={`${d.day} — ${fmtInt(d.sales)} vente(s) simulée(s) · ${fmtDh(d.rewardCents)}`}>
            <div className="bg-blue-500 rounded-t-sm" style={{ height: `${((d.rewardCents || 0) / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-gray-400"><span>{rows[0]?.day}</span><span>{rows[rows.length - 1]?.day}</span></div>
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-600 font-semibold">Tableau jour par jour</summary>
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-[11px]">
            <thead className="text-gray-500"><tr><th className="py-1 pe-2 text-start font-semibold">Jour</th><th className="py-1 pe-2 text-end font-semibold">Ventes simulées</th><th className="py-1 text-end font-semibold">Récompense simulée</th></tr></thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
              {[...rows].reverse().map((d) => (
                <tr key={d.day}><td className="py-1 pe-2 whitespace-nowrap">{d.day}</td><td className="py-1 pe-2 text-end">{fmtInt(d.sales)}</td><td className="py-1 text-end whitespace-nowrap">{fmtDh(d.rewardCents)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Settings versions (newest first): what the simulation used from each date on. */
function Versions({ versions }) {
  const rows = Array.isArray(versions) ? versions : [];
  if (!rows.length) return <p className="text-xs text-gray-400">Aucune version.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead className="text-gray-500">
          <tr>
            <th className="py-1 pe-2 text-start font-semibold">En vigueur depuis</th>
            <th className="py-1 pe-2 text-start font-semibold">Active</th>
            <th className="py-1 pe-2 text-start font-semibold">Ventes / jour</th>
            <th className="py-1 pe-2 text-start font-semibold">Récompense</th>
            <th className="py-1 text-start font-semibold">Par</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 text-gray-700">
          {rows.map((v, i) => (
            <tr key={v.id || i}>
              <td className="py-1 pe-2 whitespace-nowrap">{fmtDateTime(v.effectiveFrom)}</td>
              <td className="py-1 pe-2">{v.active ? "oui" : "non"}</td>
              <td className="py-1 pe-2 whitespace-nowrap">{v.minDailySales}–{v.maxDailySales}</td>
              <td className="py-1 pe-2 whitespace-nowrap">{v.rewardPerSaleMad} DH / vente</td>
              <td className="py-1 truncate max-w-[120px]">{v.createdBy || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * props: id (null = create), state (GET /ugc-videos payload: members, videos, limits, uploads, counts, settings),
 *        onClose(), onChanged(), onCreated(id)
 * A retired (archived) video opens read-only with a Restore action (it comes back disabled).
 */
export default function VideoEditor({ id, state, onClose, onChanged, onCreated }) {
  const creating = !id;
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(creating ? formFrom(null) : null);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const limits = state?.limits || {};
  const salesMax = limits.salesMax ?? UGC_LIMITS.salesMax;
  const uploads = state?.uploads || DEFAULT_UPLOADS;
  const members = Array.isArray(state?.members) ? state.members : [];
  const enabled = !!state?.settings?.enabled;

  useEffect(() => {
    if (creating) return;
    let alive = true;
    dcApi(`${UGC}/videos/${id}`).then((r) => {
      if (!alive) return;
      if (r.ok) { setDetail(r.data.video); setForm(formFrom(r.data.video)); }
      else setLoadError(ugcErrorText(r));
    });
    return () => { alive = false; };
  }, [id, creating]);

  const reload = async () => {
    const r = await dcApi(`${UGC}/videos/${id}`);
    if (r.ok) { setDetail(r.data.video); setForm(formFrom(r.data.video)); setErrors({}); }
    return r;
  };

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };

  const save = async () => {
    const { payload, errors: local } = buildPayload(form, creating, salesMax);
    if (Object.keys(local).length) { setErrors(local); setNotice({ ok: false, text: "Corrigez les champs signalés." }); return; }
    setBusy(true);
    setNotice(null);
    const r = creating
      ? await dcApi(`${UGC}/videos`, { method: "POST", body: payload })
      : await dcApi(`${UGC}/videos/${id}`, { method: "PATCH", body: payload });
    setBusy(false);
    if (!r.ok) { setErrors(r.fields || {}); setNotice({ ok: false, text: ugcErrorText(r) }); return; }
    setErrors({});
    if (creating) { onCreated(r.data?.video?.id); return; }
    setDetail(r.data.video);
    setForm(formFrom(r.data.video));
    setNotice({ ok: true, text: "Enregistré. Actif, ventes min/max et récompense s'appliquent aux futures ventes simulées uniquement : l'historique ne change pas." });
    onChanged();
  };

  const archive = async () => {
    if (!window.confirm(`Retirer la vidéo démo « ${detail?.title} » ?\n\nElle sera désactivée et disparaîtra du classement public UGC Videos. Rien n'est supprimé : son historique de ventes simulées est conservé et vous pourrez la restaurer plus tard (elle reviendra désactivée).`)) return;
    setBusy(true);
    setNotice(null);
    const r = await dcApi(`${UGC}/videos/${id}/archive`, { method: "POST" });
    if (r.ok) await reload();
    setBusy(false);
    if (r.ok) { setNotice({ ok: true, text: "Vidéo démo retirée : historique conservé, hors classement public. Vous pouvez la restaurer." }); onChanged(); }
    else setNotice({ ok: false, text: ugcErrorText(r) });
  };

  const restore = async () => {
    setBusy(true);
    setNotice(null);
    const r = await dcApi(`${UGC}/videos/${id}/restore`, { method: "POST" });
    if (r.ok) await reload();
    setBusy(false);
    if (r.ok) { setNotice({ ok: true, text: "Vidéo démo restaurée, mais désactivée : activez « Active » puis Enregistrer pour la remettre dans le classement." }); onChanged(); }
    else setNotice({ ok: false, text: ugcErrorText(r) });
  };

  /** A file uploaded on an existing video is attached at once (the API returns the updated video). */
  const uploaded = (field) => (url, data) => {
    setForm((f) => ({ ...f, [field]: url }));
    setErrors((e) => ({ ...e, [field]: undefined }));
    if (!creating && data?.video) {
      setDetail(data.video);
      onChanged();
      setNotice({ ok: true, text: field === "videoUrl" ? "Fichier vidéo enregistré." : "Miniature enregistrée." });
    }
  };

  const title = creating ? "Nouvelle vidéo UGC démo" : detail ? `Vidéo UGC démo — ${detail.title}` : "Vidéo UGC démo";
  if (!form) {
    return (
      <Drawer title={title} onClose={onClose}>
        {loadError ? <Notice notice={{ ok: false, text: loadError }} /> : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>}
      </Drawer>
    );
  }

  const archived = !!detail?.archivedAt;
  // Videos owned per member (non-archived videos): one member can own several videos.
  const owned = new Map();
  for (const v of state?.videos || []) if (!v.archivedAt) owned.set(v.memberId, (owned.get(v.memberId) || 0) + 1);
  const ownerMissing = form.memberId && !members.some((m) => m.id === form.memberId);
  const selected = members.find((m) => m.id === form.memberId) || (ownerMissing ? detail?.owner : null);
  const atLimit = (state?.counts?.videos ?? 0) >= (limits.maxVideos ?? UGC_LIMITS.maxVideos);
  const restoreBlockers = [
    ...(atLimit ? ["Limite de 100 vidéos démo non retirées atteinte : retirez d'abord une autre vidéo."] : []),
    ...(detail?.owner?.archivedAt ? ["Le membre démo propriétaire est archivé : restaurez-le d'abord dans Demo Members."] : []),
  ];
  const mediaPath = (kind) => (creating ? `${UGC}/upload/${kind}` : `${UGC}/videos/${id}/${kind}`);
  const pending = (field) => !creating && !!detail && (form[field] || null) !== (detail[field] || null);
  const s = detail?.stats || {};

  return (
    <Drawer title={title} onClose={onClose} busy={busy}>
      <div className="flex flex-wrap items-center gap-2"><SimBadge />{detail && <VideoBadges v={detail} enabled={enabled} />}</div>
      <SimulationNotice compact />
      <UgcSimulationNote />
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {archived && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-2 text-amber-900" data-ugc-archived-banner>
          <p className="text-sm font-bold">Vidéo retirée le {fmtDateTime(detail.archivedAt)} — lecture seule</p>
          <p className="text-xs leading-relaxed">
            Elle ne génère plus de ventes simulées et n&apos;apparaît plus dans le classement public. Son historique est conservé.
            Restaurez-la pour la modifier : elle reviendra <strong>désactivée</strong>, à réactiver ensuite ici.
          </p>
          {restoreBlockers.length > 0 && <ul className="text-xs list-disc ps-4 space-y-0.5">{restoreBlockers.map((b) => <li key={b}>{b}</li>)}</ul>}
          <button type="button" className={btnPrimary} disabled={busy || restoreBlockers.length > 0} onClick={restore}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArchiveRestore className="w-3.5 h-3.5" />} Restaurer cette vidéo démo
          </button>
        </section>
      )}

      {/* Retired = read-only: the fieldset disables every input / button of the form. */}
      <fieldset disabled={archived || busy} className="space-y-4 min-w-0" data-ugc-admin-form>
        <Section title="Vidéo">
          <UgcField label="Titre" hint={`${UGC_LIMITS.titleMax} caractères maximum`} error={errors.title}>
            <input className={inputCls} maxLength={limits.titleMax ?? UGC_LIMITS.titleMax} value={form.title} onChange={(e) => set("title", e.target.value)} />
          </UgcField>
          <UgcField label="Propriétaire (membre démo)" hint="Un même membre démo peut posséder plusieurs vidéos." error={errors.memberId}>
            <div className="flex items-center gap-2 min-w-0">
              <Avatar src={selected?.avatarUrl} name={selected?.name} size={32} />
              <select className={inputCls} value={form.memberId} onChange={(e) => set("memberId", e.target.value)}>
                <option value="">— Choisir un membre démo —</option>
                {ownerMissing && <option value={form.memberId} disabled>{detail?.owner?.name || "Membre"} (archivé)</option>}
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {owned.get(m.id) || 0} vidéo{(owned.get(m.id) || 0) > 1 ? "s" : ""}{m.active ? "" : " · membre désactivé"}
                  </option>
                ))}
              </select>
            </div>
          </UgcField>
          {members.length === 0 && (
            <p className="text-[11px] text-amber-700">Aucun membre démo non archivé. <Link href="/admin/demo-competition/members" className="underline">Créer des membres démo →</Link></p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
            <Switch checked={form.active} onChange={(v) => set("active", v)} label="Active" />
            <span>{form.active ? "Active (génère des ventes simulées)" : "Désactivée (plus de ventes simulées, hors classement)"}</span>
          </div>
          <UgcFieldError code={errors.active} />
        </Section>

        <Section title="Ventes et récompense simulées">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UgcField label="Min. ventes simulées / jour" error={errors.minDailySales}>
              <input className={inputCls} inputMode="numeric" value={form.minDailySales} onChange={(e) => set("minDailySales", e.target.value)} />
            </UgcField>
            <UgcField label="Max. ventes simulées / jour" error={errors.maxDailySales}>
              <input className={inputCls} inputMode="numeric" value={form.maxDailySales} onChange={(e) => set("maxDailySales", e.target.value)} />
            </UgcField>
            <UgcField label="Récompense simulée par vente" error={errors.rewardPerSaleMad}>
              <select className={inputCls} value={form.rewardPerSaleMad} onChange={(e) => set("rewardPerSaleMad", e.target.value)} data-ugc-reward-select>
                {REWARD_CHOICES.map((n) => <option key={n} value={String(n)}>{n} DH par vente</option>)}
              </select>
            </UgcField>
            <UgcField label="Ordre d'affichage" hint={creating ? "Vide = à la fin. Départage les égalités du classement." : "Départage les égalités du classement (plus petit d'abord)."} error={errors.sortOrder}>
              <input className={inputCls} inputMode="numeric" value={form.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} />
            </UgcField>
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            Chaque jour (heure de Casablanca), le serveur tire un nombre de ventes simulées entre le min et le max, réparties dans la journée.
            Récompense simulée = ventes × {REWARD_CHOICES.join(" / ")} DH. Les changements s&apos;appliquent aux <strong>futures</strong> ventes
            simulées : l&apos;historique garde ses valeurs.
          </p>
        </Section>

        <Section title="Fichiers">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-600 mb-1">Fichier vidéo</p>
              <MediaUploader
                kind="video" path={mediaPath("video")} url={form.videoUrl} poster={form.thumbnailUrl} uploads={uploads}
                disabled={archived || busy} onUploaded={uploaded("videoUrl")} onRemove={() => set("videoUrl", null)} pending={pending("videoUrl")}
              />
              <UgcFieldError code={errors.videoUrl} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-600 mb-1">Miniature</p>
              <MediaUploader
                kind="thumbnail" path={mediaPath("thumbnail")} url={form.thumbnailUrl} uploads={uploads}
                disabled={archived || busy} onUploaded={uploaded("thumbnailUrl")} onRemove={() => set("thumbnailUrl", null)} pending={pending("thumbnailUrl")}
              />
              <UgcFieldError code={errors.thumbnailUrl} />
            </div>
          </div>
          <p className="text-[11px] text-gray-500">
            {creating
              ? "Les fichiers téléversés ici sont joints à la vidéo lors de la création."
              : "Un fichier téléversé est enregistré immédiatement sur cette vidéo."}{" "}
            Sans fichier vidéo, la vidéo n&apos;est <strong>pas visible</strong> dans le classement public.
          </p>
        </Section>

        {!archived && (
          <div className="flex justify-end">
            <button type="button" className={btnPrimary} disabled={busy} onClick={save}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} {creating ? "Créer la vidéo démo" : "Enregistrer"}
            </button>
          </div>
        )}
      </fieldset>

      {detail && (
        <>
          <Section title="Statistiques simulées" right={<span className="text-[11px] text-gray-500">Rang {detail.rank ? `#${detail.rank}` : "—"}</span>}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Tile label="24 h" value={fmtDh(s.reward24hCents)} sub={`${fmtInt(s.sales24h)} vente(s)`} />
              <Tile label="7 jours" value={fmtDh(s.reward7dCents)} sub={`${fmtInt(s.sales7d)} vente(s)`} />
              <Tile label="30 jours" value={fmtDh(s.reward30dCents)} sub={`${fmtInt(s.sales30d)} vente(s)`} />
              <Tile label="Total" value={fmtDh(s.rewardAllCents)} sub={`${fmtInt(s.salesAll)} vente(s)`} />
            </div>
            <p className="text-[11px] text-gray-500">Dernière vente simulée : {fmtDateTime(detail.lastSaleAt)} · créée le {fmtDateTime(detail.createdAt)}</p>
          </Section>
          <Section title="Historique 30 jours">
            <DailyHistory daily={detail.history?.daily} />
          </Section>
          <Section title="Historique des réglages">
            <Versions versions={detail.versions} />
          </Section>
          {!archived && (
            <Section title="Retirer la vidéo">
              <p className="text-xs text-gray-500 leading-relaxed">
                Rien n&apos;est supprimé : retirer (archiver) désactive la vidéo, qui ne génère plus de ventes simulées et disparaît du
                classement public. Son historique est <strong>conservé</strong> et reste visible ici ; vous pourrez la restaurer plus tard
                (elle reviendra désactivée). Les vidéos retirées ne comptent pas dans la limite de 100.
              </p>
              <button type="button" className={btnDanger} disabled={busy} onClick={archive}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />} Retirer cette vidéo démo
              </button>
            </Section>
          )}
        </>
      )}
    </Drawer>
  );
}
