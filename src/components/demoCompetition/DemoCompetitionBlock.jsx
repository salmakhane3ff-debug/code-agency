"use client";
/**
 * DemoCompetitionBlock — wraps the Top Members / Top Brands sections that follow each other
 * (affiliate dashboard; independent builder sections):
 *   · ONE compact banner for the block: the competition title, the real participant counts
 *     reported by the sections and the rolling 30-day window;
 *   · phones / tablets: the compact sections stacked; desktop (lg, ≥ 1024 px) with two
 *     sections: side by side;
 *   · ONE discreet simulation footnote under the sections (<SimulationNote>, text from the
 *     central src/lib/demoCompetition/disclosure.js — not repeated in every section);
 *   · hidden when every section in it reported an empty competition (nothing to lead).
 * There is no monthly cycle (rolling 30-day ranking, approved): the banner shows no cycle number
 * and no "days left" — only real data.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Trophy } from "lucide-react";
import { useDemoText } from "./useLivePolling";
import { SimulationNote } from "./Badges";

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

/** `lang` (optional): the page's own language (the Affiliate Dashboard passes its market language); default: the site language. */
export default function DemoCompetitionBlock({ count = 1, lang: langOverride, children }) {
  const { t, lang, dir } = useDemoText(langOverride);
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
        </header>
        <div className={count > 1 ? "grid items-start gap-3 lg:grid-cols-2 lg:gap-5" : "mx-auto max-w-3xl"}>
          {children}
        </div>
        <SimulationNote lang={lang} className="mt-2.5" />
      </div>
    </BlockContext.Provider>
  );
}
