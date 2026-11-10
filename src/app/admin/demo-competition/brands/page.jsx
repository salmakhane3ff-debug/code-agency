"use client";
// /admin/demo-competition/brands — demo brands of the Demo Competition (SIMULATION ONLY;
// unrelated to the "Create Your Own Brand" program).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Loader2, RefreshCw, Pencil, ArchiveRestore } from "lucide-react";
import { DEFAULTS, MAX_BRANDS } from "@/lib/demoCompetition/engine";
import {
  dcApi, PageHeader, SimulationNotice, Counter, Notice, ActiveBadge, LiveDot, Avatar, btnPrimary, btnGhost, cardCls,
  fmtDh, fmtInt, fmtDate, fmtDateTime, fmtPct, splitArchived, ArchivedSection,
} from "../_components/ui";
import BrandEditor from "../_components/BrandEditor";

export default function DemoBrandsPage() {
  const [list, setList] = useState(null);
  const [members, setMembers] = useState([]);
  const [engine, setEngine] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = create, id = edit
  const [notice, setNotice] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [restoring, setRestoring] = useState(null); // id being restored

  const load = useCallback(async () => {
    setRefreshing(true);
    const [b, m, e] = await Promise.all([dcApi("/brands"), dcApi("/members"), dcApi("/engine")]);
    setRefreshing(false);
    if (b.ok) { setList(b.data); setLoadError(null); } else setLoadError(b.error);
    // All members (archived included, flagged by archivedAt): the editor lists only the non-archived ones as owners.
    if (m.ok) setMembers((m.data.members || []).map(({ id, name, photoUrl, active, archivedAt }) => ({ id, name, photoUrl, active, archivedAt: archivedAt ?? null })));
    if (e.ok) setEngine(e.data.engine);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Primitive deps: a list refresh must not re-create the defaults (the open editor would reload its form).
  const defPrice = engine?.defaultPriceCents ?? DEFAULTS.priceCents;
  const defBps = engine?.defaultBrandBps ?? DEFAULTS.brandBps;
  const defaults = useMemo(() => ({
    priceCents: defPrice, brandBps: defBps, minDailyOrders: DEFAULTS.minDailyOrders, maxDailyOrders: DEFAULTS.maxDailyOrders,
  }), [defPrice, defBps]);

  // Main table = active + disabled brands; archived ones live in their own section and do NOT count against the limit.
  const { current: brands, archived } = splitArchived(list?.brands);
  const max = list?.max ?? MAX_BRANDS;
  const full = brands.length >= max;
  const noMembers = list && !members.some((m) => !m.archivedAt);
  const archivedMemberIds = new Set(members.filter((m) => m.archivedAt).map((m) => m.id));

  const restore = async (b) => {
    setRestoring(b.id);
    const r = await dcApi(`/brands/${b.id}/restore`, { method: "POST" });
    setRestoring(null);
    if (r.ok) setNotice({ ok: true, text: `« ${b.name} » restaurée, mais désactivée : ouvrez-la et activez « Active » pour la remettre dans le classement.` });
    else setNotice({ ok: false, text: r.error });
    load();
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-4">
      <PageHeader title="Demo Brands" subtitle="Marques fictives du classement Top Brands, chacune possédée par un membre démo.">
        <Counter value={brands.length} max={max} label="marques" />
        <button type="button" className={btnGhost} onClick={load} disabled={refreshing}>
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Actualiser
        </button>
        <button
          type="button" className={btnPrimary} disabled={!list || full || noMembers} onClick={() => setEditing(null)}
          title={full ? `Limite de ${max} marques démo atteinte` : noMembers ? "Créez d'abord un membre démo" : undefined}
        >
          <Plus className="w-3.5 h-3.5" /> Nouvelle marque
        </button>
      </PageHeader>
      <SimulationNotice />
      {full && <p className="text-xs text-gray-500">Limite atteinte : {max} marques démo au maximum. Archivez une marque pour en créer (ou en restaurer) une autre.</p>}
      {noMembers && <p className="text-xs text-amber-700">Une marque démo doit appartenir à un membre démo non archivé : créez (ou restaurez) d&apos;abord un membre.</p>}
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {!list ? (
        <div className="flex justify-center py-16">
          {loadError ? <Notice notice={{ ok: false, text: loadError }} /> : <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}
        </div>
      ) : brands.length === 0 && archived.length === 0 ? (
        <div className={`${cardCls} p-8 text-center text-sm text-gray-500`}>
          Aucune marque démo. Créez-en une ou utilisez « Initialiser » dans <Link href="/admin/demo-competition/engine" className="text-blue-600 hover:underline">Live Engine</Link>.
        </div>
      ) : brands.length === 0 ? (
        <div className={`${cardCls} p-8 text-center text-sm text-gray-500`}>Aucune marque démo non archivée : restaurez-en une ci-dessous ou créez-en une.</div>
      ) : (
        <div className={`${cardCls} overflow-x-auto`}>
          <table className="w-full text-sm min-w-[960px]">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-start">Rang</th>
                <th className="px-3 py-2 text-start">Marque</th>
                <th className="px-3 py-2 text-start">Propriétaire</th>
                <th className="px-3 py-2 text-start">Statut</th>
                <th className="px-3 py-2 text-end">24 h</th>
                <th className="px-3 py-2 text-end">7 j</th>
                <th className="px-3 py-2 text-end">30 j</th>
                <th className="px-3 py-2 text-end">Total</th>
                <th className="px-3 py-2 text-end">Cmd démo</th>
                <th className="px-3 py-2 text-end">Prix · alloc.</th>
                <th className="px-3 py-2 text-start">Créée le</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {brands.map((b) => (
                <tr key={b.id} className="hover:bg-gray-50/60 cursor-pointer" onClick={() => setEditing(b.id)}>
                  <td className="px-3 py-2 font-bold text-gray-700">{b.rank ? `#${b.rank}` : "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Avatar src={b.imageUrl} name={b.name} size={36} />
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate max-w-[180px]">{b.name}</p>
                        <LiveDot live={b.live} />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Avatar src={b.owner?.photoUrl} name={b.owner?.name} size={24} />
                      <span className="text-xs text-gray-700 truncate max-w-[140px]">{b.owner?.name || "—"}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2"><ActiveBadge active={b.active} /></td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">{fmtDh(b.stats?.earnings24hCents)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">{fmtDh(b.stats?.earnings7dCents)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap font-semibold">{fmtDh(b.stats?.earnings30dCents)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">{fmtDh(b.stats?.earningsAllCents)}</td>
                  <td className="px-3 py-2 text-end">{fmtInt(b.stats?.ordersAll)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap text-xs text-gray-600">{fmtDh(b.priceCents)} · {fmtPct(b.allocationBps)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{fmtDate(b.createdAt)}</td>
                  <td className="px-3 py-2 text-end">
                    <button type="button" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" aria-label={`Modifier ${b.name}`} onClick={(e) => { e.stopPropagation(); setEditing(b.id); }}>
                      <Pencil className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list && (
        <ArchivedSection count={archived.length}>
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-start">Marque</th>
                <th className="px-3 py-2 text-start">Propriétaire</th>
                <th className="px-3 py-2 text-start">Archivée le</th>
                <th className="px-3 py-2 text-end">Total (historique)</th>
                <th className="px-3 py-2 text-end">Cmd démo</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {archived.map((b) => {
                const ownerArchived = !!b.owner && archivedMemberIds.has(b.owner.id);
                const blocked = full || ownerArchived;
                return (
                  <tr key={b.id} className="hover:bg-gray-50/60 cursor-pointer text-gray-600" onClick={() => setEditing(b.id)}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Avatar src={b.imageUrl} name={b.name} size={32} />
                        <p className="font-semibold truncate max-w-[180px]">{b.name}</p>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {b.owner?.name || "—"}
                      {ownerArchived && <span className="block text-[11px] text-amber-700">membre archivé</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(b.archivedAt)}</td>
                    <td className="px-3 py-2 text-end whitespace-nowrap">{fmtDh(b.stats?.earningsAllCents)}</td>
                    <td className="px-3 py-2 text-end">{fmtInt(b.stats?.ordersAll)}</td>
                    <td className="px-3 py-2 text-end whitespace-nowrap">
                      <button
                        type="button" className={btnGhost} disabled={blocked || restoring !== null}
                        title={full ? `Limite de ${max} marques démo non archivées atteinte` : ownerArchived ? "Le membre propriétaire est archivé : restaurez-le d'abord" : "Revient désactivée, à réactiver dans l'éditeur"}
                        onClick={(e) => { e.stopPropagation(); restore(b); }}
                      >
                        {restoring === b.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArchiveRestore className="w-3.5 h-3.5" />} Restaurer
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {full && <p className="px-4 py-2 text-[11px] text-gray-500">Restauration impossible tant que {max} marques non archivées existent.</p>}
        </ArchivedSection>
      )}

      {editing !== undefined && (
        <BrandEditor
          key={editing ?? "new"}
          id={editing}
          members={members}
          defaults={defaults}
          full={full}
          onClose={() => setEditing(undefined)}
          onChanged={load}
          onCreated={(id) => { setNotice({ ok: true, text: "Marque démo créée (30 jours d'historique démo générés). Ajoutez l'image produit." }); load(); setEditing(id || undefined); }}
        />
      )}
    </div>
  );
}
