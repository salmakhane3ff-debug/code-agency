"use client";
/**
 * HomeSectionFrame — a COMPACT homepage leaderboard panel (Top Members / Top Brands): a white
 * rounded panel with a one-line header (small icon, title, live dot, "Démo / Simulation" badge,
 * small "Voir tout" link) and the compact rows. The simulation disclaimer is shown once for the
 * whole block, in the DemoCompetitionBlock banner — not repeated here. The section element is the
 * live-polling target (`sectionRef`) and hides itself when the competition is empty.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { SimulationBadge } from "./Badges";

export default function HomeSectionFrame({
  sectionRef, dir, lang, hidden, title, icon, viewAllHref, showViewAll = true, t, error, hasData, children,
}) {
  return (
    <section ref={sectionRef} dir={dir} lang={lang} hidden={hidden} className="w-full min-w-0 rounded-2xl border border-gray-100 bg-white p-2.5 text-start shadow-sm min-[400px]:p-3" aria-label={title}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-x-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            <h3 className="text-[15px] font-extrabold leading-tight text-gray-900"><bdi>{title}</bdi></h3>
            <span className="dc-live-dot dc-live-dot--green" role="img" aria-label={t("updates_live")} title={t("updates_live")} />
          </span>
          <SimulationBadge t={t} iconOnlyOnPhone />
        </div>
        {showViewAll && (
          <Link
            href={viewAllHref}
            className="inline-flex min-h-[36px] shrink-0 items-center gap-0.5 rounded-full px-2.5 text-[13px] font-bold text-violet-700 transition-colors hover:bg-violet-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            {t("view_all")}
            <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          </Link>
        )}
      </div>
      {error && !hasData && <p role="status" className="mb-2 text-xs text-gray-500">{t("error_load")}</p>}
      {children}
    </section>
  );
}
