"use client";
// /admin/demo-competition — hub of the Demo Competition section (SIMULATION ONLY).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users, Store, Activity, LayoutGrid, ChevronRight, Loader2 } from "lucide-react";
import { MAX_MEMBERS, MAX_BRANDS } from "@/lib/demoCompetition/engine";
import { dcApi, PageHeader, SimulationNotice, Notice, cardCls, fmtInt, fmtDateTime } from "./_components/ui";

export default function DemoCompetitionHub() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    dcApi("/engine").then((r) => (r.ok ? setState(r.data) : setError(r.error)));
  }, []);

  const counts = state?.counts;
  const limits = state?.limits || { members: MAX_MEMBERS, brands: MAX_BRANDS };
  const engine = state?.engine;
  const v = (x) => (state ? x : <Loader2 className="w-4 h-4 animate-spin text-gray-300" />);
  // counts.members / counts.brands = NON-archived profiles only (the limits apply to them); archived ones are counted apart.
  const archivedNote = (n, one, many) => (n ? ` · ${n} ${n > 1 ? many : one}` : "");

  const cards = [
    { href: "/admin/demo-competition/members", icon: Users, title: "Demo Members", desc: `Profils, photos, réglages de ventes démo et réseau démo.${archivedNote(counts?.archivedMembers, "archivé", "archivés")}`, stat: v(`${counts?.members ?? 0} / ${limits.members}`) },
    { href: "/admin/demo-competition/brands", icon: Store, title: "Demo Brands", desc: `Marques démo, image produit, propriétaire, réglages.${archivedNote(counts?.archivedBrands, "archivée", "archivées")}`, stat: v(`${counts?.brands ?? 0} / ${limits.brands}`) },
    {
      href: "/admin/demo-competition/engine", icon: Activity, title: "Live Engine",
      desc: engine ? `Dernière exécution : ${fmtDateTime(engine.lastRunAt)} · ${fmtInt(counts?.events)} événements démo` : "Génération serveur, initialisation, valeurs par défaut.",
      stat: v(engine?.enabled ? <span className="text-green-600">ON</span> : <span className="text-gray-400">OFF</span>),
    },
    { href: "/admin/demo-competition/homepage", icon: LayoutGrid, title: "Homepage Settings", desc: "Sections Top Members / Top Brands de la page d'accueil.", stat: null },
  ];

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-4">
      <PageHeader back={false} title="🏁 Demo Competition" subtitle="Classements Top Members / Top Brands alimentés par des profils et des ventes de démonstration." />
      <SimulationNotice />
      {error && <Notice notice={{ ok: false, text: error }} />}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {cards.map(({ href, icon: Icon, title, desc, stat }) => (
          <Link key={href} href={href} className={`${cardCls} p-4 flex items-center gap-3 hover:shadow-md transition-shadow`}>
            <span className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0"><Icon className="w-5 h-5" /></span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-900">{title}</p>
              <p className="text-xs text-gray-500">{desc}</p>
            </div>
            {stat !== null && <span className="text-sm font-bold text-gray-800 whitespace-nowrap">{stat}</span>}
            <ChevronRight className="w-4 h-4 text-gray-300" />
          </Link>
        ))}
      </div>
      {state && counts.members === 0 && counts.brands === 0 && (
        <p className="text-xs text-gray-500">
          Pour démarrer : <Link href="/admin/demo-competition/engine" className="text-blue-600 hover:underline">Live Engine</Link> → « Initialiser {MAX_MEMBERS} membres + {MAX_BRANDS} marques », puis renommez les profils et ajoutez photos / images produit.
        </p>
      )}
    </div>
  );
}
