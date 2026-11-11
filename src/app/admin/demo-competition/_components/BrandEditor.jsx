"use client";
// Create / edit drawer of a demo brand (SIMULATION ONLY — not the Create Your Own Brand program, no real money).

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import {
  dcApi, dhToCents, percentToBps, toInt, centsToInput, bpsToInput, inputCls, btnPrimary, Field, Toggle, Notice,
  StatsGrid, DailyBars, RecentEvents, VersionHistory, FutureOnlyHint, SimulationNotice, Avatar,
} from "./ui";
import { Drawer, Section, ImageUploader, RateFields, ArchiveZone, ArchivedBanner } from "./ProfileParts";

const KEYS = { min: "minDailyOrders", max: "maxDailyOrders", price: "priceDh", priceErr: "priceCents", pct: "allocationPct", pctErr: "allocationBps" };
const ERROR_KEY = { priceDh: "priceCents", allocationPct: "allocationBps" };

function formFrom(b, defaults) {
  return {
    name: b?.name ?? "",
    ownerId: b?.ownerId ?? "",
    active: b ? !!b.active : true,
    minDailyOrders: String(b?.minDailyOrders ?? defaults.minDailyOrders),
    maxDailyOrders: String(b?.maxDailyOrders ?? defaults.maxDailyOrders),
    priceDh: centsToInput(b?.priceCents ?? defaults.priceCents),
    allocationPct: bpsToInput(b?.allocationBps ?? defaults.brandBps),
  };
}

/** Form strings → API payload (centimes via dhToCents, bps via percentToBps) + client-side field errors. */
function buildPayload(f) {
  const errors = {};
  const int = (k, code) => { const n = toInt(f[k]); if (Number.isNaN(n)) errors[k] = code; return n; };
  const payload = {
    name: f.name.trim(),
    ownerId: f.ownerId,
    active: !!f.active,
    minDailyOrders: int("minDailyOrders", "INVALID_MIN_ORDERS"),
    maxDailyOrders: int("maxDailyOrders", "INVALID_MAX_ORDERS"),
    priceCents: dhToCents(f.priceDh),
    allocationBps: percentToBps(f.allocationPct),
  };
  if (!payload.name) errors.name = "INVALID_NAME";
  if (!payload.ownerId) errors.ownerId = "OWNER_REQUIRED";
  if (payload.priceCents === null) errors.priceCents = "INVALID_PRICE";
  if (payload.allocationBps === null) errors.allocationBps = "INVALID_ALLOCATION";
  return { payload, errors };
}

/**
 * props: id (null = create), members [{id,name,photoUrl,active,archivedAt}] (all members; only non-archived ones can own a brand),
 *        defaults { priceCents, brandBps, minDailyOrders, maxDailyOrders }, full (20 non-archived brands already: restoring is refused),
 *        onClose(), onChanged(), onCreated(id)
 * An archived brand opens read-only, with a Restore action (it comes back disabled).
 */
export default function BrandEditor({ id, members, defaults, full = false, onClose, onChanged, onCreated }) {
  const creating = !id;
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(creating ? formFrom(null, defaults) : null);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (creating) return;
    let alive = true;
    dcApi(`/brands/${id}`).then((r) => {
      if (!alive) return;
      if (r.ok) { setDetail(r.data.brand); setForm(formFrom(r.data.brand, defaults)); }
      else setLoadError(r.error);
    });
    return () => { alive = false; };
  }, [id, creating, defaults]);

  /** Re-read the detail after archive / restore (the form follows the server state). */
  const reload = async () => {
    const r = await dcApi(`/brands/${id}`);
    if (r.ok) { setDetail(r.data.brand); setForm(formFrom(r.data.brand, defaults)); setErrors({}); }
    return r;
  };

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined, [ERROR_KEY[k] || k]: undefined })); };

  const save = async () => {
    const { payload, errors: local } = buildPayload(form);
    if (Object.keys(local).length) { setErrors(local); setNotice({ ok: false, text: "Corrigez les champs signalés." }); return; }
    setBusy(true);
    setNotice(null);
    const r = creating
      ? await dcApi("/brands", { method: "POST", body: payload })
      : await dcApi(`/brands/${id}`, { method: "PATCH", body: payload });
    setBusy(false);
    if (!r.ok) { setErrors(r.fields); setNotice({ ok: false, text: r.error }); return; }
    setErrors({});
    if (creating) { onCreated(r.data?.brand?.id); return; }
    setDetail(r.data.brand);
    setForm(formFrom(r.data.brand, defaults));
    setNotice({ ok: true, text: "Enregistré. Les changements s'appliquent aux futurs événements démo uniquement." });
    onChanged();
  };

  const archive = async () => {
    if (!window.confirm(`Archiver la marque démo « ${detail?.name} » ?\n\nElle sera désactivée : plus aucun événement démo et elle disparaît des classements publics. Son historique démo est conservé et vous pourrez la restaurer.`)) return;
    setBusy(true);
    setNotice(null);
    const r = await dcApi(`/brands/${id}/archive`, { method: "POST" });
    if (r.ok) await reload();
    setBusy(false);
    if (r.ok) { setNotice({ ok: true, text: "Marque démo archivée : historique conservé, retirée des classements publics." }); onChanged(); }
    else setNotice({ ok: false, text: r.error });
  };

  const restore = async () => {
    setBusy(true);
    setNotice(null);
    const r = await dcApi(`/brands/${id}/restore`, { method: "POST" });
    if (r.ok) await reload();
    setBusy(false);
    if (r.ok) { setNotice({ ok: true, text: "Marque démo restaurée, mais désactivée : activez l'interrupteur « Active » puis Enregistrer pour la remettre dans le classement." }); onChanged(); }
    else setNotice({ ok: false, text: r.error });
  };

  const title = creating ? "Nouvelle marque démo" : detail ? `Marque démo — ${detail.name}` : "Marque démo";
  if (!form) {
    return (
      <Drawer title={title} onClose={onClose}>
        {loadError ? <Notice notice={{ ok: false, text: loadError }} /> : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>}
      </Drawer>
    );
  }

  const archived = !!detail?.archivedAt;
  // Only non-archived members can own a brand (the API answers fields.ownerId = OWNER_ARCHIVED otherwise).
  const selectable = members.filter((m) => !m.archivedAt);
  const owner = members.find((m) => m.id === form.ownerId) || (detail?.owner && detail.owner.id === form.ownerId ? detail.owner : null);
  const ownerArchived = !!(owner?.archivedAt);
  // Keep the current owner visible in the (disabled) select of an archived brand even when that member is archived.
  const options = owner && !selectable.some((m) => m.id === owner.id) ? [...selectable, owner] : selectable;
  const restoreBlockers = [];
  if (full) restoreBlockers.push("Limite de 20 marques démo non archivées atteinte : archivez d'abord une autre marque.");
  if (ownerArchived) restoreBlockers.push(`Le membre propriétaire « ${owner.name} » est archivé : restaurez-le d'abord (Demo Members).`);

  return (
    <Drawer title={title} onClose={onClose} busy={busy}>
      <SimulationNotice compact />
      <Notice notice={notice} onClose={() => setNotice(null)} />
      {archived && <ArchivedBanner archivedAt={detail.archivedAt} blockers={restoreBlockers} onRestore={restore} busy={busy} label="Restaurer cette marque démo" />}

      {/* Archived = read-only: the fieldset disables every input / button of the form. */}
      <fieldset disabled={archived} className="space-y-4 min-w-0">
        {!creating && !archived && (
          <Section title="Image produit">
            <ImageUploader
              path={`/brands/${id}/image`} resultKey="imageUrl" currentUrl={detail?.imageUrl} name={detail?.name} round
              onUploaded={(url) => { setDetail((d) => ({ ...d, imageUrl: url })); onChanged(); setNotice({ ok: true, text: "Image mise à jour." }); }}
            />
          </Section>
        )}

        <Section title="Marque">
          <Field label="Nom de la marque" error={errors.name}>
            <input className={inputCls} maxLength={80} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Membre démo propriétaire" error={errors.ownerId} hint="Un membre peut posséder plusieurs marques.">
            <div className="flex items-center gap-2">
              <Avatar src={owner?.photoUrl} name={owner?.name} size={36} />
              <select className={inputCls} value={form.ownerId} onChange={(e) => set("ownerId", e.target.value)}>
                <option value="">— Choisir un membre démo —</option>
                {options.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.archivedAt ? " (archivé)" : m.active ? "" : " (désactivé)"}</option>
                ))}
              </select>
            </div>
          </Field>
          {!selectable.length && <p className="text-[11px] text-amber-700">Créez (ou restaurez) d&apos;abord au moins un membre démo non archivé.</p>}
          <Toggle checked={form.active} onChange={(v) => set("active", v)} label={form.active ? "Active (visible dans le classement)" : "Désactivée (masquée, plus d'événements)"} />
          {creating && <p className="text-[11px] text-gray-500">L&apos;image produit se téléverse après la création. Une nouvelle marque reçoit immédiatement 30 jours d&apos;historique démo (même si le moteur est désactivé).</p>}
        </Section>

        <Section title="Ventes démo de la marque">
          <RateFields
            form={form} set={set} errors={errors} keys={KEYS} allocationLabel="Allocation marque (%)"
            remainderLabel="coûts simulés de livraison, plateforme et confirmation."
          />
          <FutureOnlyHint />
        </Section>

        {!archived && (
          <div className="flex justify-end">
            <button type="button" className={btnPrimary} disabled={busy || !selectable.length} onClick={save}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} {creating ? "Créer la marque démo" : "Enregistrer"}
            </button>
          </div>
        )}
      </fieldset>

      {detail && (
        <>
          <Section title="Statistiques démo" right={<span className="text-[11px] text-gray-500">Rang {detail.rank ?? "—"}</span>}>
            <StatsGrid stats={detail.stats} />
          </Section>
          <Section title="Historique 30 jours">
            <DailyBars daily={detail.history?.daily} />
          </Section>
          <Section title="Événements démo récents">
            <RecentEvents recent={detail.history?.recent} />
          </Section>
          <Section title="Historique des réglages">
            <VersionHistory versions={detail.versions} />
          </Section>
          {!archived && <ArchiveZone blockers={[]} onArchive={archive} busy={busy} label="Archiver cette marque démo" />}
        </>
      )}
    </Drawer>
  );
}
