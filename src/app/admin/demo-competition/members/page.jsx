"use client";
// /admin/demo-competition/members — demo members of the Demo Competition (SIMULATION ONLY).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Loader2, RefreshCw, Pencil, ArchiveRestore } from "lucide-react";
import { DEFAULTS, MAX_MEMBERS } from "@/lib/demoCompetition/engine";
import {
  dcApi, PageHeader, SimulationNotice, Counter, Notice, ActiveBadge, LiveDot, Avatar, btnPrimary, btnGhost, cardCls,
  fmtDh, fmtInt, fmtDate, fmtDateTime, splitArchived, ArchivedSection,
} from "../_components/ui";
import MemberEditor from "../_components/MemberEditor";

export default function DemoMembersPage() {
  const [list, setList] = useState(null);
  const [engine, setEngine] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = create, id = edit
  const [notice, setNotice] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [restoring, setRestoring] = useState(null); // id being restored

  const load = useCallback(async () => {
    setRefreshing(true);
    const [m, e] = await Promise.all([dcApi("/members"), dcApi("/engine")]);
    setRefreshing(false);
    if (m.ok) { setList(m.data); setLoadError(null); } else setLoadError(m.error);
    if (e.ok) setEngine(e.data.engine);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Primitive deps: a list refresh must not re-create the defaults (the open editor would reload its form).
  const defPrice = engine?.defaultPriceCents ?? DEFAULTS.priceCents;
  const defBps = engine?.defaultMemberBps ?? DEFAULTS.memberBps;
  const defaults = useMemo(() => ({
    priceCents: defPrice, memberBps: defBps, minDailyOrders: DEFAULTS.minDailyOrders, maxDailyOrders: DEFAULTS.maxDailyOrders,
  }), [defPrice, defBps]);

  // Main table = active + disabled members; archived ones live in their own section and do NOT count against the limit.
  const { current: members, archived } = splitArchived(list?.members);
  const max = list?.max ?? MAX_MEMBERS;
  const full = members.length >= max;

  const restore = async (m) => {
    setRestoring(m.id);
    const r = await dcApi(`/members/${m.id}/restore`, { method: "POST" });
    setRestoring(null);
    if (r.ok) setNotice({ ok: true, text: `« ${m.name} » restauré, mais désactivé : ouvrez-le et activez « Actif » pour le remettre dans le classement.` });
    else setNotice({ ok: false, text: r.error });
    load();
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-4">
      <PageHeader title="Demo Members" subtitle="Membres fictifs du classement Top Members (gains démo sur 30 jours glissants).">
        <Counter value={members.length} max={max} label="membres" />
        <button type="button" className={btnGhost} onClick={load} disabled={refreshing}>
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Actualiser
        </button>
        <button
          type="button" className={btnPrimary} disabled={!list || full} onClick={() => setEditing(null)}
          title={full ? `Limite de ${max} membres démo atteinte` : undefined}
        >
          <Plus className="w-3.5 h-3.5" /> Nouveau membre
        </button>
      </PageHeader>
      <SimulationNotice />
      {full && <p className="text-xs text-gray-500">Limite atteinte : la compétition compte exactement {max} membres démo au maximum. Archivez un membre pour en créer (ou en restaurer) un autre.</p>}
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {!list ? (
        <div className="flex justify-center py-16">
          {loadError ? <Notice notice={{ ok: false, text: loadError }} /> : <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}
        </div>
      ) : members.length === 0 && archived.length === 0 ? (
        <div className={`${cardCls} p-8 text-center text-sm text-gray-500`}>
          Aucun membre démo. Créez-en un ou utilisez « Initialiser » dans <Link href="/admin/demo-competition/engine" className="text-blue-600 hover:underline">Live Engine</Link>.
        </div>
      ) : members.length === 0 ? (
        <div className={`${cardCls} p-8 text-center text-sm text-gray-500`}>Aucun membre démo non archivé : restaurez-en un ci-dessous ou créez-en un.</div>
      ) : (
        <div className={`${cardCls} overflow-x-auto`}>
          <table className="w-full text-sm min-w-[960px]">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-start">Rang</th>
                <th className="px-3 py-2 text-start">Membre</th>
                <th className="px-3 py-2 text-start">Statut</th>
                <th className="px-3 py-2 text-end">24 h</th>
                <th className="px-3 py-2 text-end">7 j</th>
                <th className="px-3 py-2 text-end">30 j</th>
                <th className="px-3 py-2 text-end">Total</th>
                <th className="px-3 py-2 text-end">Cmd démo</th>
                <th className="px-3 py-2 text-end">Réseau 30 j</th>
                <th className="px-3 py-2 text-end">Marques</th>
                <th className="px-3 py-2 text-start">Créé le</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {members.map((m) => (
                <tr key={m.id} className="hover:bg-gray-50/60 cursor-pointer" onClick={() => setEditing(m.id)}>
                  <td className="px-3 py-2 font-bold text-gray-700">{m.rank ? `#${m.rank}` : "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Avatar src={m.photoUrl} name={m.name} size={36} />
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate max-w-[180px]">{m.name}</p>
                        <LiveDot live={m.live} />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2"><ActiveBadge active={m.active} /></td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">{fmtDh(m.stats?.earnings24hCents)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">{fmtDh(m.stats?.earnings7dCents)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap font-semibold">{fmtDh(m.stats?.earnings30dCents)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">{fmtDh(m.stats?.earningsAllCents)}</td>
                  <td className="px-3 py-2 text-end">{fmtInt(m.stats?.ordersAll)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">
                    {m.networkPriceCents !== null && m.networkAllocationBps !== null && m.networkAffiliates > 0
                      ? fmtDh(m.network?.earnings30dCents)
                      : <span className="text-[11px] text-gray-400">non configuré</span>}
                  </td>
                  <td className="px-3 py-2 text-end">{m.brands}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{fmtDate(m.createdAt)}</td>
                  <td className="px-3 py-2 text-end">
                    <button type="button" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" aria-label={`Modifier ${m.name}`} onClick={(e) => { e.stopPropagation(); setEditing(m.id); }}>
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
                <th className="px-3 py-2 text-start">Membre</th>
                <th className="px-3 py-2 text-start">Archivé le</th>
                <th className="px-3 py-2 text-end">Total (historique)</th>
                <th className="px-3 py-2 text-end">Cmd démo</th>
                <th className="px-3 py-2 text-end">Marques</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {archived.map((m) => (
                <tr key={m.id} className="hover:bg-gray-50/60 cursor-pointer text-gray-600" onClick={() => setEditing(m.id)}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Avatar src={m.photoUrl} name={m.name} size={32} />
                      <p className="font-semibold truncate max-w-[180px]">{m.name}</p>
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(m.archivedAt)}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">{fmtDh(m.stats?.earningsAllCents)}</td>
                  <td className="px-3 py-2 text-end">{fmtInt(m.stats?.ordersAll)}</td>
                  <td className="px-3 py-2 text-end">{m.brands}</td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">
                    <button
                      type="button" className={btnGhost} disabled={full || restoring !== null}
                      title={full ? `Limite de ${max} membres démo non archivés atteinte` : "Revient désactivé, à réactiver dans l'éditeur"}
                      onClick={(e) => { e.stopPropagation(); restore(m); }}
                    >
                      {restoring === m.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArchiveRestore className="w-3.5 h-3.5" />} Restaurer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {full && <p className="px-4 py-2 text-[11px] text-gray-500">Restauration impossible tant que {max} membres non archivés existent.</p>}
        </ArchivedSection>
      )}

      {editing !== undefined && (
        <MemberEditor
          key={editing ?? "new"}
          id={editing}
          defaults={defaults}
          full={full}
          onClose={() => setEditing(undefined)}
          onChanged={load}
          onCreated={(id) => { setNotice({ ok: true, text: "Membre démo créé (30 jours d'historique démo générés). Ajoutez sa photo." }); load(); setEditing(id || undefined); }}
        />
      )}
    </div>
  );
}
