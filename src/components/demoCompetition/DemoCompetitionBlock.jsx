"use client";
/**
 * DemoCompetitionBlock — wraps the homepage Demo Competition sections that follow each other
 * in the homepage layout (Top Members / Top Brands, independent builder sections):
 *   · ONE compact banner for the block: "Démo / Simulation" kicker, the competition title, the
 *     real participant counts reported by the sections and the rolling 30-day window, and the
 *     single simulation disclaimer of the block (not repeated in every section);
 *   · phones / tablets: the compact sections stacked; desktop (lg, ≥ 1024 px) with two
 *     sections: side by side;
 *   · hidden when every section in it reported an empty competition (nothing to lead).
 * There is no monthly cycle (rolling 30-day ranking, approved): the banner shows no cycle number
 * and no "days left" — only real data.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Trophy } from "lucide-react";
import { useDemoText, useNeutralDemoText } from "./useLivePolling";

const BlockContext = createContext(null);

/**
 * Called by a section inside the block: `empty` when its leaderboard has no profile, `total` the
 * number of active profiles of its kind ("member" | "brand"). Outside a block it is a no-op.
 */
export function useDemoBlockReport(key, empty, kind, total) {
  const ctx = useContext(BlockContext);
  useEffect(() => { if (ctx) ctx.report(key, empty); }, [ctx, key, empty]);
  useEffect(() => { if (ctx && kind && Number.isInteger(total)) ctx.count(kind, total); }, [ctx, kind, total]);
}

export default function DemoCompetitionBlock({ count = 1, children }) {
  const { t, lang, dir } = useNeutralDemoText(useDemoText());
  const [empties, setEmpties] = useState({});
  const [totals, setTotals] = useState({});
  const report = useCallback((key, empty) => {
    setEmpties((prev) => (prev[key] === empty ? prev : { ...prev, [key]: empty }));
  }, []);
  const countFn = useCallback((kind, total) => {
    setTotals((prev) => (prev[kind] === total ? prev : { ...prev, [kind]: total }));
  }, []);
  const ctx = useMemo(() => ({ report, count: countFn }), [report, countFn]);
  const reported = Object.values(empties);
  const allEmpty = reported.length >= count && reported.every(Boolean);
  const big = totals.member ?? totals.brand;
  const meta = [totals.member != null && totals.brand != null ? t("banner_brands", { n: totals.brand }) : null, t("rolling_window")].filter(Boolean).join(" · ");

  return (
    <BlockContext.Provider value={ctx}>
      <div dir={dir} lang={lang} hidden={allEmpty} className="text-start">
        <header className="mb-3 overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-700 px-4 py-3 text-white shadow-md sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {t("sim_badge") && <p className="mb-0.5 text-[11px] font-bold uppercase tracking-[0.14em] text-indigo-200">{t("sim_badge")}</p>}
              <h2 className="text-[17px] font-black leading-tight sm:text-[20px]">
                <Trophy className="me-1.5 inline-block h-[1.05em] w-[1.05em] align-[-0.15em] text-amber-300" fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
                {t("community_title")}
              </h2>
              <p className="mt-1 text-[12px] leading-snug text-indigo-200">{meta}</p>
            </div>
            {big != null && (
              <div className="shrink-0 text-center">
                <p className="text-[28px] font-black leading-none tabular-nums"><bdi dir="ltr">{big}</bdi></p>
                <p className="mt-0.5 text-[11px] text-indigo-200">{t("banner_participants")}</p>
              </div>
            )}
          </div>
          {t("sim_banner") && (
            <p role="note" className="mt-2 border-t border-white/15 pt-1.5 text-[11px] leading-snug text-indigo-100/90">
              <strong className="font-bold text-white">{t("sim_banner_title")}</strong>{" — "}{t("sim_banner")}
            </p>
          )}
        </header>
        <div className={count > 1 ? "grid items-start gap-3 lg:grid-cols-2 lg:gap-5" : "mx-auto max-w-3xl"}>
          {children}
        </div>
      </div>
    </BlockContext.Provider>
  );
}
