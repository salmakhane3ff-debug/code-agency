"use client";
// Create / edit drawer of a demo member (SIMULATION ONLY — no real affiliate, order or money).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Save, Network } from "lucide-react";
import {
  dcApi, dhToCents, percentToBps, toInt, centsToInput, bpsToInput, inputCls, btnPrimary, Field, Toggle, Notice,
  StatsGrid, DailyBars, RecentEvents, VersionHistory, FutureOnlyHint, SimulationNotice, fmtDh, fmtInt, Avatar, StatusBadge,
} from "./ui";
import { Drawer, Section, ImageUploader, RateFields, ArchiveZone, ArchivedBanner } from "./ProfileParts";

const PERSONAL_KEYS = { min: "minDailyOrders", max: "maxDailyOrders", price: "priceDh", priceErr: "priceCents", pct: "allocationPct", pctErr: "allocationBps" };
const NETWORK_KEYS = { min: "networkMinDailyOrders", max: "networkMaxDailyOrders", price: "networkPriceDh", priceErr: "networkPriceCents", pct: "networkAllocationPct", pctErr: "networkAllocationBps" };

/** Form key → API field key (for clearing a field error when the input changes). */
const ERROR_KEY = { priceDh: "priceCents", allocationPct: "allocationBps", networkPriceDh: "networkPriceCents", networkAllocationPct: "networkAllocationBps" };

function formFrom(m, defaults) {
  return {
    name: m?.name ?? "",
    active: m ? !!m.active : true,
    minDailyOrders: String(m?.minDailyOrders ?? defaults.minDailyOrders),
    maxDailyOrders: String(m?.maxDailyOrders ?? defaults.maxDailyOrders),
    priceDh: centsToInput(m?.priceCents ?? defaults.priceCents),
    allocationPct: bpsToInput(m?.allocationBps ?? defaults.memberBps),
    networkAffiliates: String(m?.networkAffiliates ?? 0),
    networkMinDailyOrders: String(m?.networkMinDailyOrders ?? 0),
    networkMaxDailyOrders: String(m?.networkMaxDailyOrders ?? 0),
    networkPriceDh: centsToInput(m?.networkPriceCents ?? null),
    networkAllocationPct: bpsToInput(m?.networkAllocationBps ?? null),
  };
}

/** Form strings → API payload (centimes via dhToCents, bps via percentToBps) + client-side field errors. */
function buildPayload(f) {
  const errors = {};
  const int = (k, code) => { const n = toInt(f[k]); if (Number.isNaN(n)) errors[k] = code; return n; };
  const payload = {
    name: f.name.trim(),
    active: !!f.active,
    minDailyOrders: int("minDailyOrders", "INVALID_MIN_ORDERS"),
    maxDailyOrders: int("maxDailyOrders", "INVALID_MAX_ORDERS"),
    priceCents: dhToCents(f.priceDh),
    allocationBps: percentToBps(f.allocationPct),
    networkAffiliates: int("networkAffiliates", "INVALID_AFFILIATES"),
    networkMinDailyOrders: int("networkMinDailyOrders", "INVALID_MIN_ORDERS"),
    networkMaxDailyOrders: int("networkMaxDailyOrders", "INVALID_MAX_ORDERS"),
    networkPriceCents: f.networkPriceDh.trim() === "" ? null : dhToCents(f.networkPriceDh),
    networkAllocationBps: f.networkAllocationPct.trim() === "" ? null : percentToBps(f.networkAllocationPct),
  };
  if (!payload.name) errors.name = "INVALID_NAME";
  if (payload.priceCents === null) errors.priceCents = "INVALID_PRICE";
  if (payload.allocationBps === null) errors.allocationBps = "INVALID_ALLOCATION";
  if (f.networkPriceDh.trim() !== "" && payload.networkPriceCents === null) errors.networkPriceCents = "INVALID_PRICE";
  if (f.networkAllocationPct.trim() !== "" && payload.networkAllocationBps === null) errors.networkAllocationBps = "INVALID_ALLOCATION";
  if ((f.networkPriceDh.trim() === "") !== (f.networkAllocationPct.trim() === "")) errors.networkAllocationBps = "NETWORK_RATE_INCOMPLETE";
  return { payload, errors };
}

/**
 * props: id (null = create), defaults { priceCents, memberBps, minDailyOrders, maxDailyOrders },
 *        full (21 non-archived members already: restoring is refused), onClose(), onChanged(), onCreated(id)
 * An archived member opens read-only, with a Restore action (it comes back disabled).
 */
export default function MemberEditor({ id, defaults, full = false, onClose, onChanged, onCreated }) {
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
    dcApi(`/members/${id}`).then((r) => {
      if (!alive) return;
      if (r.ok) { setDetail(r.data.member); setForm(formFrom(r.data.member, defaults)); }
      else setLoadError(r.error);
    });
    return () => { alive = false; };
  }, [id, creating, defaults]);

  /** Re-read the detail after archive / restore (the form follows the server state). */
  const reload = async () => {
    const r = await dcApi(`/members/${id}`);
    if (r.ok) { setDetail(r.data.member); setForm(formFrom(r.data.member, defaults)); setErrors({}); }
    return r;
  };

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined, [ERROR_KEY[k] || k]: undefined })); };

  const save = async () => {
    const { payload, errors: local } = buildPayload(form);
    if (Object.keys(local).length) { setErrors(local); setNotice({ ok: false, text: "Corrigez les champs signalés." }); return; }
    setBusy(true);
    setNotice(null);
    const r = creating
      ? await dcApi("/members", { method: "POST", body: payload })
      : await dcApi(`/members/${id}`, { method: "PATCH", body: payload });
    setBusy(false);
    if (!r.ok) { setErrors(r.fields); setNotice({ ok: false, text: r.error }); return; }
    setErrors({});
    if (creating) { onCreated(r.data?.member?.id); return; }
    setDetail(r.data.member);
    setForm(formFrom(r.data.member, defaults));
    setNotice({ ok: true, text: "Enregistré. Les changements s'appliquent aux futurs événements démo uniquement." });
    onChanged();
  };

  const archive = async () => {
    if (!window.confirm(`Archiver le membre démo « ${detail?.name} » ?\n\nIl sera désactivé : plus aucun événement démo et il disparaît des classements publics. Son historique démo est conservé et vous pourrez le restaurer.`)) return;
    setBusy(true);
    setNotice(null);
    const r = await dcApi(`/members/${id}/archive`, { method: "POST" });
    if (r.ok) await reload();
    setBusy(false);
    if (r.ok) { setNotice({ ok: true, text: "Membre démo archivé : historique conservé, retiré des classements publics." }); onChanged(); }
    else setNotice({ ok: false, text: r.error });
  };

  const restore = async () => {
    setBusy(true);
    setNotice(null);
    const r = await dcApi(`/members/${id}/restore`, { method: "POST" });
    if (r.ok) await reload();
    setBusy(false);
    if (r.ok) { setNotice({ ok: true, text: "Membre démo restauré, mais désactivé : activez l'interrupteur « Actif » puis Enregistrer pour le remettre dans le classement." }); onChanged(); }
    else setNotice({ ok: false, text: r.error });
  };

  const title = creating ? "Nouveau membre démo" : detail ? `Membre démo — ${detail.name}` : "Membre démo";
  if (!form) {
    return (
      <Drawer title={title} onClose={onClose}>
        {loadError ? <Notice notice={{ ok: false, text: loadError }} /> : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>}
      </Drawer>
    );
  }

  const netPriceSet = form.networkPriceDh.trim() !== "", netPctSet = form.networkAllocationPct.trim() !== "";
  const netConfigured = netPriceSet && netPctSet;
  const netOn = netConfigured && toInt(form.networkAffiliates) > 0;
  const brands = detail?.brands || [];
  const archived = !!detail?.archivedAt;
  const liveBrands = brands.filter((b) => !b.archivedAt);
  const archiveBlockers = liveBrands.length
    ? [`Il possède encore ${liveBrands.length} marque(s) démo non archivée(s) : archivez-les ou réattribuez-les à un autre membre d'abord.`]
    : [];
  const restoreBlockers = full ? ["Limite de 21 membres démo non archivés atteinte : archivez d'abord un autre membre."] : [];

  return (
    <Drawer title={title} onClose={onClose} busy={busy}>
      <SimulationNotice compact />
      <Notice notice={notice} onClose={() => setNotice(null)} />
      {archived && <ArchivedBanner archivedAt={detail.archivedAt} blockers={restoreBlockers} onRestore={restore} busy={busy} label="Restaurer ce membre démo" />}

      {/* Archived = read-only: the fieldset disables every input / button of the form. */}
      <fieldset disabled={archived} className="space-y-4 min-w-0">
        {!creating && !archived && (
          <Section title="Photo">
            <ImageUploader
              path={`/members/${id}/photo`} resultKey="photoUrl" currentUrl={detail?.photoUrl} name={detail?.name} round
              onUploaded={(url) => { setDetail((d) => ({ ...d, photoUrl: url })); onChanged(); setNotice({ ok: true, text: "Photo mise à jour." }); }}
            />
          </Section>
        )}

        <Section title="Profil">
          <Field label="Nom affiché" error={errors.name}>
            <input className={inputCls} maxLength={80} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Toggle checked={form.active} onChange={(v) => set("active", v)} label={form.active ? "Actif (visible dans le classement)" : "Désactivé (masqué, plus d'événements)"} />
          {creating && <p className="text-[11px] text-gray-500">La photo se téléverse après la création. Un nouveau membre reçoit immédiatement 30 jours d&apos;historique démo (même si le moteur est désactivé).</p>}
        </Section>

        <Section title="Ventes démo personnelles">
          <RateFields form={form} set={set} errors={errors} keys={PERSONAL_KEYS} allocationLabel="Allocation membre (%)" />
          <FutureOnlyHint />
        </Section>

        <Section
          title="Réseau démo"
          right={
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${netOn ? "bg-violet-50 text-violet-700 border-violet-200" : "bg-gray-100 text-gray-500 border-gray-200"}`}>
              <Network className="w-3 h-3" /> {netOn ? "Réseau actif" : netConfigured ? "Aucun affilié démo" : "Non configuré"}
            </span>
          }
        >
          <p className="text-[11px] text-gray-500">
            Le flux réseau reste désactivé tant que le prix ET l&apos;allocation réseau ne sont pas renseignés (aucun taux par défaut),
            ou tant que le nombre d&apos;affiliés démo vaut 0. Laissez prix et allocation vides pour le désactiver.
          </p>
          <Field label="Nombre d'affiliés démo" error={errors.networkAffiliates}>
            <input className={inputCls} inputMode="numeric" value={form.networkAffiliates} onChange={(e) => set("networkAffiliates", e.target.value)} />
          </Field>
          <RateFields form={form} set={set} errors={errors} keys={NETWORK_KEYS} allocationLabel="Allocation réseau (%)" />
        </Section>

        {!archived && (
          <div className="flex justify-end">
            <button type="button" className={btnPrimary} disabled={busy} onClick={save}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} {creating ? "Créer le membre démo" : "Enregistrer"}
            </button>
          </div>
        )}
      </fieldset>

      {detail && (
        <>
          <Section title="Statistiques démo" right={<span className="text-[11px] text-gray-500">Rang {detail.rank ?? "—"}</span>}>
            <StatsGrid stats={detail.stats} />
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-xl bg-violet-50 border border-violet-100 p-2.5"><p className="text-[11px] text-violet-700">Réseau 30 j</p><p className="font-bold">{fmtDh(detail.network?.earnings30dCents)}</p></div>
              <div className="rounded-xl bg-violet-50 border border-violet-100 p-2.5"><p className="text-[11px] text-violet-700">Réseau total</p><p className="font-bold">{fmtDh(detail.network?.earningsAllCents)}</p></div>
              <div className="rounded-xl bg-violet-50 border border-violet-100 p-2.5"><p className="text-[11px] text-violet-700">Cmd réseau</p><p className="font-bold">{fmtInt(detail.network?.ordersAll)}</p></div>
            </div>
          </Section>
          <Section title="Historique 30 jours">
            <DailyBars daily={detail.history?.daily} network />
          </Section>
          <Section title="Événements démo récents">
            <RecentEvents recent={detail.history?.recent} />
          </Section>
          <Section title={`Marques démo possédées (${brands.length})`}>
            {brands.length
              ? <ul className="space-y-1.5">{brands.map((b) => (
                <li key={b.id} className="flex items-center gap-2 text-sm"><Avatar src={b.imageUrl} name={b.name} size={28} /><span className="flex-1 truncate">{b.name}</span><StatusBadge active={b.active} archivedAt={b.archivedAt} /></li>
              ))}</ul>
              : <p className="text-xs text-gray-400">Aucune marque.</p>}
            <Link href="/admin/demo-competition/brands" className="text-xs text-blue-600 hover:underline">Gérer les marques démo →</Link>
          </Section>
          <Section title="Historique des réglages">
            <VersionHistory versions={detail.versions} network />
          </Section>
          {!archived && <ArchiveZone blockers={archiveBlockers} onArchive={archive} busy={busy} label="Archiver ce membre démo" />}
        </>
      )}
    </Drawer>
  );
}
